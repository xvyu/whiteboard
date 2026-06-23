"""
协作白板 V2 - 定时任务（定时快照 + 房间清理）
"""

import json
import logging
from datetime import datetime, timezone

from .database import Session, engine
from .models import CanvasSnapshotDB, RoomDB
from .room_manager import online_rooms

logger = logging.getLogger("whiteboard-v2")

# 快照间隔（秒）
SNAPSHOT_INTERVAL = 180  # 3分钟


async def take_snapshots():
    """
    定时快照任务：定期将在线房间的画板状态保存到 canvas_snapshots 表
    """
    while True:
        await asyncio_sleep(SNAPSHOT_INTERVAL)
        try:
            _do_snapshots()
        except Exception as e:
            logger.error(f"[快照] 执行快照时出错: {e}")


def _do_snapshots():
    """同步执行快照（可在启动时直接调用）"""
    if not online_rooms:
        return

    db = Session(engine)
    try:
        count = 0
        for room_key, room in list(online_rooms.items()):
            objects = room.drawing_objects
            if not objects:
                continue

            # 查找 room_db
            room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
            if not room_db:
                continue

            # 保存快照
            snapshot = CanvasSnapshotDB(
                room_id=room_db.id,
                drawing_data=json.dumps(objects, ensure_ascii=False, default=str),
                object_count=len(objects),
            )
            db.add(snapshot)
            count += 1

        db.commit()
        if count > 0:
            logger.info(f"[快照] 已保存 {count} 个房间的快照")
    except Exception as e:
        db.rollback()
        logger.error(f"[快照] 保存快照失败: {e}")
    finally:
        db.close()


def load_latest_snapshot(room_key: str) -> list:
    """
    从数据库加载指定房间的最新快照
    返回 drawing_objects 列表，无快照则返回空列表
    """
    db = Session(engine)
    try:
        room_db = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
        if not room_db:
            return []

        snapshot = (
            db.query(CanvasSnapshotDB)
            .filter(CanvasSnapshotDB.room_id == room_db.id)
            .order_by(CanvasSnapshotDB.created_at.desc())
            .first()
        )
        if snapshot and snapshot.drawing_data:
            return json.loads(snapshot.drawing_data)
        return []
    except Exception as e:
        logger.error(f"[恢复] 加载房间 {room_key} 快照失败: {e}")
        return []
    finally:
        db.close()


def restore_all_rooms():
    """
    启动时加载所有活跃房间的最新快照到内存
    """
    db = Session(engine)
    try:
        rooms = db.query(RoomDB).all()
        restored = 0
        for room_db in rooms:
            snapshot = (
                db.query(CanvasSnapshotDB)
                .filter(CanvasSnapshotDB.room_id == room_db.id)
                .order_by(CanvasSnapshotDB.created_at.desc())
                .first()
            )
            if snapshot and snapshot.drawing_data:
                from .room_manager import get_or_create_online_room
                room = get_or_create_online_room(room_db.room_key)
                room.drawing_objects = json.loads(snapshot.drawing_data)
                # 标记房间为活跃，防止被清理
                room.last_active = datetime.now(timezone.utc).timestamp()
                restored += 1
        if restored > 0:
            logger.info(f"[恢复] 已从数据库恢复 {restored} 个房间的画板状态")
        return restored
    except Exception as e:
        logger.error(f"[恢复] 启动恢复失败: {e}")
        return 0
    finally:
        db.close()


# 兼容 asyncio.sleep（模块级别）
async def asyncio_sleep(seconds):
    import asyncio
    await asyncio.sleep(seconds)
