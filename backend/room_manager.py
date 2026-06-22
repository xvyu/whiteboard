"""
协作白板 V2 - 在线房间管理器
"""

import time
from typing import Dict, List, Optional

from fastapi import WebSocket


class OnlineRoom:
    """管理一个房间的实时 WebSocket 连接"""

    def __init__(self, room_key: str):
        self.room_key = room_key
        self.users: Dict[str, dict] = {}  # ws_key -> {ws, user_id, nickname, color, wsKey}
        self.owner_key: Optional[str] = None  # 房主的 ws_key
        self.password: Optional[str] = None  # 房间密码（可选）
        self.drawing_objects: List[dict] = []  # 当前画板图形
        self.history: List[dict] = []
        self.max_history = 200
        self.last_active = time.time()

    def add_user(self, key: str, ws: WebSocket, user_id: int, nickname: str, color: str):
        self.users[key] = {"ws": ws, "user_id": user_id, "nickname": nickname, "color": color, "wsKey": key}
        # 第一个加入房间的用户自动成为房主
        if self.owner_key is None:
            self.owner_key = key
        self.last_active = time.time()

    def remove_user(self, key: str):
        self.users.pop(key, None)
        # 房主离开后，指定下一个用户为新房主（如果有）
        if self.owner_key == key and self.users:
            next_key = next(iter(self.users))
            self.owner_key = next_key
        # 房间所有用户离开时重置房主
        # ⚠️ 注意：self.password 不在此处清空！
        # 密码清除是业务层逻辑（websocket.py），涉及数据库操作，由调用方统一处理
        if self.is_empty():
            self.owner_key = None
        self.last_active = time.time()

    def user_count(self) -> int:
        return len(self.users)

    def is_empty(self) -> bool:
        return len(self.users) == 0

    def get_users_info(self) -> dict:
        return {
            k: {"userId": u["user_id"], "nickname": u["nickname"], "color": u["color"], "wsKey": k}
            for k, u in self.users.items()
        }

    def get_ws_by_key(self, key: str) -> Optional[WebSocket]:
        user = self.users.get(key)
        return user["ws"] if user else None

    def add_history(self, entry: dict):
        self.history.append(entry)
        if len(self.history) > self.max_history:
            self.history.pop(0)

    def undo(self) -> Optional[dict]:
        if not self.history:
            return None
        last = self.history.pop()
        action = last.get("action", "")
        if action == "add" and last.get("object"):
            oid = last["object"].get("id")
            self.drawing_objects = [o for o in self.drawing_objects if o.get("id") != oid]
        elif action == "remove" and last.get("object"):
            idx = min(last.get("index", len(self.drawing_objects)), len(self.drawing_objects))
            self.drawing_objects.insert(idx, last["object"])
        elif action == "clear" and last.get("old_objects"):
            self.drawing_objects = last["old_objects"]
        elif action == "modify" and last.get("id") and last.get("old_values"):
            # 撤销修改操作：恢复对象的旧值
            for obj in self.drawing_objects:
                if obj.get("id") == last["id"]:
                    obj.update(last["old_values"])
                    break
        return last


# 全局在线房间字典
online_rooms: Dict[str, OnlineRoom] = {}


def get_or_create_online_room(room_key: str) -> OnlineRoom:
    if room_key not in online_rooms:
        online_rooms[room_key] = OnlineRoom(room_key)
    return online_rooms[room_key]


async def broadcast_to_room(room: OnlineRoom, message: dict, exclude_key: Optional[str] = None):
    disconnected = []
    for key, user in list(room.users.items()):
        if key == exclude_key:
            continue
        try:
            await user["ws"].send_json(message)
        except Exception:
            disconnected.append(key)
    for key in disconnected:
        room.remove_user(key)
