"""
协作白板 V2 - WebSocket 端点
"""

import asyncio
import json
import time
import uuid
import logging
from contextlib import closing
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import UserDB, RoomDB, WhiteboardStateDB, ChatMessageDB, CanvasSnapshotDB
from ..config import USER_COLORS
from ..auth import verify_token
from ..room_manager import get_or_create_online_room, broadcast_to_room
from ..redis_client import redis_client, room_key as redis_room_key

logger = logging.getLogger("whiteboard-v2")

router = APIRouter(tags=["WebSocket"])


def _persist_drawing_objects(room_key: str, objects: list):
    """将画板状态同时写入 Redis 和 PostgreSQL"""
    import json

    # 写 Redis（或内存缓存）
    redis_client.set_json(redis_room_key(room_key), objects, ttl=3600)

    # 写 PostgreSQL（异步风格，同步写入 whiteboard_states 表作为实时备份）
    from ..database import Session, engine as _eng
    _db = Session(_eng)
    try:
        room_db = _db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
        if room_db:
            # 更新或创建一条"实时状态"记录（id=-1 表示最新状态）
            state = _db.query(WhiteboardStateDB).filter(
                WhiteboardStateDB.room_id == room_db.id,
                WhiteboardStateDB.name == "__live__"
            ).first()
            if state:
                state.drawing_data = json.dumps(objects, ensure_ascii=False, default=str)
                state.updated_at = datetime.now()
            else:
                state = WhiteboardStateDB(
                    room_id=room_db.id,
                    user_id=None,
                    name="__live__",
                    drawing_data=json.dumps(objects, ensure_ascii=False, default=str),
                )
                _db.add(state)
            _db.commit()
    except Exception as e:
        _db.rollback()
        logger.warning(f"[持久化] 写入房间 {room_key} 状态失败: {e}")
    finally:
        _db.close()


@router.websocket("/ws/{room_key}")
async def websocket_endpoint(
    websocket: WebSocket,
    room_key: str,
    token: str = Query(default=""),
    nickname: str = Query(default="匿名用户"),
    password: str = Query(default=""),
):
    await websocket.accept()

    # 认证
    user_id: Optional[int] = None
    username: str = ""
    user_color: str = "#4A90D9"

    if token:
        payload = verify_token(token)
        if payload:
            with closing(next(get_db())) as db:
                user = db.query(UserDB).filter(UserDB.id == int(payload["sub"])).first()
                if user:
                    user_id = user.id
                    username = user.username
                    nickname = user.nickname or user.username
                    user_color = user.avatar_color

    if not user_id:
        # 游客模式
        user_color = USER_COLORS[hash(nickname) % len(USER_COLORS)]

    # 房间管理
    room = get_or_create_online_room(room_key)
    ws_key = f"{user_id or uuid.uuid4().hex[:6]}_{id(websocket)}"

    # ===== 密码验证与存储 =====
    # 规则：
    # 1) 房间首次创建（DB 无记录）+ 传入密码 → 创建房间并保存密码
    # 2) 房间已有密码 → 验证密码是否匹配
    # 3) 房间已有密码但没填 → 拒绝
    # 4) 房间无密码 → 直接放行
    with closing(next(get_db())) as db:
        room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
        if room_db:
            if room_db.password:
                # 数据库中有密码 → 校验
                if password == room_db.password:
                    room_password_valid = True
                else:
                    room_password_valid = False
                room.password = room_db.password
            else:
                # 数据库无密码 → 如果第一个用户设置了密码则保存
                if password:
                    room_db.password = password
                    room.password = password
                    db.commit()
                room_password_valid = True
        else:
            # 房间尚未在数据库存在（首次创建）
            room_db = RoomDB(room_key=room_key, name=room_key)
            if password:
                room_db.password = password
                room.password = password
            db.add(room_db)
            db.commit()
            room_password_valid = True

    if not room_password_valid:
        await websocket.send_json({"type": "error", "message": "密码错误，请重新输入密码"})
        await websocket.close(1008, "密码错误")
        return

    # XSS 过滤
    safe_nickname = (
        nickname[:20]
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )

    if room.user_count() >= 100:
        await websocket.send_json({"type": "error", "message": "房间已满"})
        await websocket.close()
        return

    room.add_user(ws_key, websocket, user_id, safe_nickname, user_color)
    logger.info(f"[连接] {safe_nickname}(id={user_id}) 加入房间 {room_key}, 在线: {room.user_count()}")

    # 加载聊天历史
    chat_history = []
    with closing(next(get_db())) as db:
        room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
        if room_db:
            msgs = (
                db.query(ChatMessageDB)
                .filter(ChatMessageDB.room_id == room_db.id)
                .order_by(ChatMessageDB.created_at.desc())
                .limit(50).all()
            )
            chat_history = [
                {
                    "id": m.id,
                    "userId": m.user_id,
                    "nickname": m.nickname,
                    "color": m.user_color,
                    "content": m.content,
                    "timestamp": m.created_at.isoformat() if m.created_at else None,
                }
                for m in reversed(msgs)
            ]

    # 发送初始化
    await websocket.send_json({
        "type": "init",
        "wsKey": ws_key,
        "ownerKey": room.owner_key,
        "userId": user_id,
        "userColor": user_color,
        "nickname": safe_nickname,
        "roomKey": room_key,
        "objects": room.drawing_objects,
        "users": room.get_users_info(),
        "onlineCount": room.user_count(),
        "chatHistory": chat_history,
    })

    # 广播用户加入（包含 wsKey 供前端匹配房主身份）
    await broadcast_to_room(room, {
        "type": "user_joined",
        "wsKey": ws_key,
        "userId": user_id,
        "nickname": safe_nickname,
        "color": user_color,
        "onlineCount": room.user_count(),
        "ownerKey": room.owner_key,
    }, ws_key)

    # 速率限制
    last_msg_time = 0.0
    msg_count = 0

    try:
        while True:
            try:
                data = await asyncio.wait_for(websocket.receive_json(), timeout=60.0)
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "ping"})
                except Exception:
                    break
                continue

            room.last_active = time.time()

            # 速率限制
            now = time.time()
            if now - last_msg_time < 1.0:
                msg_count += 1
                if msg_count > 30:
                    continue
            else:
                last_msg_time = now
                msg_count = 1

            msg_type = data.get("type", "")

            try:
                # ===== 绘图消息 =====
                if msg_type == "add":
                    obj = data.get("data", {})
                    if not obj.get("id"):
                        obj["id"] = f"obj_{uuid.uuid4().hex[:8]}"
                    obj["userId"] = user_id
                    obj["userColor"] = user_color
                    room.drawing_objects.append(obj)
                    room.add_history({"action": "add", "object": dict(obj)})
                    _persist_drawing_objects(room_key, room.drawing_objects)
                    # 先通知其他用户
                    await broadcast_to_room(room, {
                        "type": "add", "data": obj, "userId": user_id,
                    }, ws_key)
                    # 再给发送者回执确认（防止 frp 丢包导致本地对象被 request_state 覆盖）
                    try:
                        await websocket.send_json({"type": "add_ack", "id": obj.get("id")})
                    except Exception:
                        pass

                elif msg_type == "modify":
                    oid = data.get("id")
                    changes = data.get("changes", {})
                    # 记录修改前的值，用于撤销
                    old_values = {}
                    for obj in room.drawing_objects:
                        if obj.get("id") == oid:
                            for key in changes:
                                if key in obj:
                                    old_values[key] = obj[key]
                            obj.update(changes)
                            break
                    if old_values:
                        room.add_history({"action": "modify", "id": oid, "old_values": old_values})
                    _persist_drawing_objects(room_key, room.drawing_objects)
                    await broadcast_to_room(room, {
                        "type": "modify", "id": oid, "changes": changes, "userId": user_id,
                    }, ws_key)
                    # 给发送者回执确认
                    try:
                        await websocket.send_json({"type": "modify_ack", "id": oid})
                    except Exception:
                        pass

                elif msg_type == "remove":
                    oid = data.get("id")
                    for i, obj in enumerate(room.drawing_objects):
                        if obj.get("id") == oid:
                            removed = room.drawing_objects.pop(i)
                            room.add_history({"action": "remove", "object": dict(removed), "index": i})
                            break
                    _persist_drawing_objects(room_key, room.drawing_objects)
                    await broadcast_to_room(room, {
                        "type": "remove", "id": oid, "userId": user_id,
                    }, ws_key)
                    # 给发送者回执确认
                    try:
                        await websocket.send_json({"type": "remove_ack", "id": oid})
                    except Exception:
                        pass

                elif msg_type == "clear":
                    old = list(room.drawing_objects)
                    room.drawing_objects.clear()
                    room.add_history({"action": "clear", "old_objects": old})
                    _persist_drawing_objects(room_key, room.drawing_objects)
                    await broadcast_to_room(room, {
                        "type": "clear", "userId": user_id,
                    }, None)
                    # 给发送者回执确认
                    try:
                        await websocket.send_json({"type": "clear_ack"})
                    except Exception:
                        pass

                elif msg_type == "undo":
                    room.undo()
                    _persist_drawing_objects(room_key, room.drawing_objects)
                    await broadcast_to_room(room, {
                        "type": "full_state", "objects": room.drawing_objects, "userId": user_id,
                    }, None)

                elif msg_type == "full_state":
                    room.drawing_objects = data.get("objects", [])
                    _persist_drawing_objects(room_key, room.drawing_objects)
                    await broadcast_to_room(room, {
                        "type": "full_state", "objects": room.drawing_objects, "userId": user_id,
                    }, ws_key)

                # ===== 聊天消息 =====
                elif msg_type == "chat":
                    content = (data.get("content", "")).strip()[:500]
                    if not content:
                        continue

                    # 存入数据库
                    msg_id = None
                    with closing(next(get_db())) as db:
                        room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
                        if not room_db:
                            room_db = RoomDB(room_key=room_key, name=room_key)
                            db.add(room_db)
                            db.commit()
                            db.refresh(room_db)

                        chat = ChatMessageDB(
                            room_id=room_db.id,
                            user_id=user_id,
                            username=username or safe_nickname,
                            nickname=safe_nickname,
                            user_color=user_color,
                            content=content,
                        )
                        db.add(chat)
                        db.commit()
                        msg_id = chat.id

                    await broadcast_to_room(room, {
                        "type": "chat",
                        "id": msg_id,
                        "userId": user_id,
                        "nickname": safe_nickname,
                        "color": user_color,
                        "content": content,
                        "timestamp": datetime.now().isoformat(),
                    }, None)

                # ===== 删除聊天消息 =====
                elif msg_type == "delete_chat":
                    chat_msg_id = data.get("id")
                    if chat_msg_id:
                        with closing(next(get_db())) as db:
                            chat_msg = db.query(ChatMessageDB).filter(ChatMessageDB.id == chat_msg_id).first()
                            if chat_msg:
                                # 允许发送者本人或房主删除
                                is_owner = (ws_key == room.owner_key)
                                is_sender = (chat_msg.user_id is not None and chat_msg.user_id == user_id)
                                if is_owner or is_sender:
                                    db.delete(chat_msg)
                                    db.commit()
                                    await broadcast_to_room(room, {
                                        "type": "chat_deleted",
                                        "id": chat_msg_id,
                                        "userId": user_id,
                                    }, None)

                # ===== 保存画板 =====
                elif msg_type == "save_state":
                    state_name = (data.get("name", "存档")).strip()[:50]
                    with closing(next(get_db())) as db:
                        room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
                        if not room_db:
                            room_db = RoomDB(room_key=room_key, name=room_key)
                            db.add(room_db)
                            db.commit()
                            db.refresh(room_db)

                        st = WhiteboardStateDB(
                            room_id=room_db.id,
                            user_id=user_id,
                            name=state_name,
                            drawing_data=json.dumps(room.drawing_objects, ensure_ascii=False),
                        )
                        db.add(st)
                        db.commit()
                        db.refresh(st)

                        await websocket.send_json({
                            "type": "state_saved",
                            "id": st.id,
                            "name": st.name,
                            "message": f"画板「{st.name}」已保存",
                        })

                # ===== 加载画板 =====
                elif msg_type == "load_state":
                    state_id = data.get("state_id")
                    with closing(next(get_db())) as db:
                        st = db.query(WhiteboardStateDB).filter(WhiteboardStateDB.id == state_id).first()
                        if st:
                            room.drawing_objects = json.loads(st.drawing_data or "[]")
                            await broadcast_to_room(room, {
                                "type": "full_state",
                                "objects": room.drawing_objects,
                                "userId": user_id,
                                "source": "load",
                                "stateName": st.name,
                            }, None)

                # ===== 请求存档列表 =====
                elif msg_type == "list_states":
                    with closing(next(get_db())) as db:
                        room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
                        states_list = []
                        if room_db:
                            states = (
                                db.query(WhiteboardStateDB)
                                .filter(WhiteboardStateDB.room_id == room_db.id)
                                .order_by(WhiteboardStateDB.updated_at.desc())
                                .limit(20).all()
                            )
                            states_list = [
                                {
                                    "id": s.id, "name": s.name,
                                    "created_at": s.created_at.isoformat() if s.created_at else None,
                                    "has_preview": bool(s.drawing_data and len(s.drawing_data) > 20),
                                }
                                for s in states
                            ]
                        await websocket.send_json({"type": "states_list", "states": states_list})

                # ===== 删除存档 =====
                elif msg_type == "delete_state":
                    state_id = data.get("state_id")
                    if state_id:
                        with closing(next(get_db())) as db:
                            st = db.query(WhiteboardStateDB).filter(WhiteboardStateDB.id == state_id).first()
                            if st:
                                db.delete(st)
                                db.commit()
                                await websocket.send_json({"type": "state_deleted", "state_id": state_id, "message": "存档已删除"})

                # ===== 存档缩略图预览 =====
                elif msg_type == "preview_state":
                    state_id = data.get("state_id")
                    if state_id:
                        with closing(next(get_db())) as db:
                            st = db.query(WhiteboardStateDB).filter(WhiteboardStateDB.id == state_id).first()
                            if st and st.drawing_data:
                                try:
                                    objects = json.loads(st.drawing_data)
                                    # 限制返回前 200 个对象，避免消息过大
                                    if len(objects) > 200:
                                        objects = objects[:200]
                                    await websocket.send_json({
                                        "type": "state_preview",
                                        "state_id": state_id,
                                        "objects": objects,
                                    })
                                except json.JSONDecodeError:
                                    pass

                # ===== 改名 =====
                elif msg_type == "rename":
                    new_name = (data.get("nickname", "匿名用户")).strip()[:20]
                    new_name = new_name.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    if ws_key in room.users:
                        room.users[ws_key]["nickname"] = new_name
                    await broadcast_to_room(room, {
                        "type": "user_renamed",
                        "userId": user_id,
                        "wsKey": ws_key,
                        "nickname": new_name,
                    }, None)

                # ===== 光标移动 =====
                elif msg_type == "cursor_move":
                    await broadcast_to_room(room, {
                        "type": "cursor_move",
                        "userId": user_id,
                        "wsKey": ws_key,
                        "x": data.get("x", 0),
                        "y": data.get("y", 0),
                        "color": user_color,
                        "nickname": safe_nickname,
                    }, ws_key)

                elif msg_type == "pong":
                    pass

                elif msg_type == "request_state":
                    await websocket.send_json({
                        "type": "full_state",
                        "objects": room.drawing_objects,
                        "userId": "server",
                        "ownerKey": room.owner_key,
                        "users": room.get_users_info(),
                    })

                # ===== 踢人（仅房主可操作） =====
                elif msg_type == "kick":
                    target_key = data.get("targetWsKey")
                    if target_key and ws_key == room.owner_key and target_key in room.users:
                        # 通知被踢用户
                        target_ws = room.get_ws_by_key(target_key)
                        if target_ws:
                            try:
                                await target_ws.send_json({"type": "kicked"})
                            except Exception:
                                pass
                        # 从房间移除
                        room.remove_user(target_key)
                        await broadcast_to_room(room, {
                            "type": "user_left",
                            "userId": room.users.get(target_key, {}).get("user_id") if target_key in room.users else None,
                            "wsKey": target_key,
                            "onlineCount": room.user_count(),
                            "newOwnerKey": room.owner_key,
                        }, None)
                        # 如果房主转移了，通知所有人新房主
                        if room.owner_key != ws_key:
                            await broadcast_to_room(room, {
                                "type": "owner_changed",
                                "ownerKey": room.owner_key,
                            }, None)

            except Exception as inner_exc:
                logger.error(f"[消息处理错误] ws {ws_key}: {inner_exc}")

    except WebSocketDisconnect:
        logger.info(f"[断开] {safe_nickname} 离开房间 {room_key}")
    except Exception as e:
        logger.error(f"[错误] ws {ws_key}: {e}")
    finally:
        room.remove_user(ws_key)
        logger.info(f"[用户] {safe_nickname} 已移除, 剩余在线: {room.user_count()}")

        await broadcast_to_room(room, {
            "type": "user_left",
            "userId": user_id,
            "wsKey": ws_key,
            "onlineCount": room.user_count(),
            "newOwnerKey": room.owner_key,
        }, None)

        # 如果房主离开且有其他用户，通知新房主
        if room.owner_key != ws_key and not room.is_empty():
            # 如果 owner_key 变了（旧房主离开），通知新房主
            pass  # remove_user 已处理转移，这里不需要额外操作

        # 所有用户退出 → 清除数据库中的房间密码
        # 直接查询数据库而非依赖 room.password（内存密码可能因各种路径被提前修改）
        if room.is_empty():
            from ..database import Session, engine as _eng
            _db = Session(_eng)
            try:
                _room_db = _db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
                if _room_db and _room_db.password:
                    logger.info(f"[密码] 房间 {room_key} 所有人已退出，准备清除DB密码 (当前值={_room_db.password})")
                    _room_db.password = None
                    _db.commit()
                    logger.info(f"[密码] 房间 {room_key} 所有人已退出，已清除密码 ✅")
                else:
                    logger.info(f"[密码] 房间 {room_key} 所有人已退出，DB密码已为空，无需清除")
            except Exception as exc:
                _db.rollback()
                logger.error(f"[密码] 房间 {room_key} 清除密码失败: {exc}")
            finally:
                _db.close()
            room.password = None
            logger.info(f"[密码] 房间 {room_key} 内存密码已清空")

        # 更新房间活跃时间（remove_user 已设置 last_active，这里额外记录断开时间）
        room.last_active = time.time()
