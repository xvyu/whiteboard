"""
协作白板 V2 - SQLAlchemy 数据模型
"""

from datetime import datetime, timezone

from sqlalchemy import (
    Column, Integer, String, Text, Boolean,
    DateTime, ForeignKey, func
)

from .database import Base


def _utcnow():
    """返回当前 UTC 时间"""
    return datetime.now(timezone.utc)


class UserDB(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(50), unique=True, nullable=False, index=True)
    password_hash = Column(String(255), nullable=False)
    nickname = Column(String(100), default="")
    avatar_color = Column(String(7), default="#4A90D9")
    created_at = Column(DateTime, default=_utcnow)


class RoomDB(Base):
    __tablename__ = "rooms"
    id = Column(Integer, primary_key=True, autoincrement=True)
    room_key = Column(String(100), unique=True, nullable=False, index=True)
    name = Column(String(100), nullable=False)
    owner_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    password = Column(String(255), nullable=True)  # 房间密码（可选）
    is_public = Column(Boolean, default=True)
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class WhiteboardStateDB(Base):
    __tablename__ = "whiteboard_states"
    id = Column(Integer, primary_key=True, autoincrement=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    name = Column(String(100), default="未命名")
    drawing_data = Column(Text, default="[]")  # JSON string of drawing objects
    created_at = Column(DateTime, default=_utcnow)
    updated_at = Column(DateTime, default=_utcnow, onupdate=_utcnow)


class ChatMessageDB(Base):
    __tablename__ = "chat_messages"
    id = Column(Integer, primary_key=True, autoincrement=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    username = Column(String(50), default="")
    nickname = Column(String(100), default="")
    user_color = Column(String(7), default="#999")
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=_utcnow)


class CanvasSnapshotDB(Base):
    """画板快照表 - 定时保存的画板状态"""
    __tablename__ = "canvas_snapshots"
    id = Column(Integer, primary_key=True, autoincrement=True)
    room_id = Column(Integer, ForeignKey("rooms.id"), nullable=False, index=True)
    drawing_data = Column(Text, default="[]")
    object_count = Column(Integer, default=0)
    created_at = Column(DateTime, default=_utcnow)
