"""
协作白板 V2 - 房间 & 存档 & 聊天消息路由
"""

import json
import uuid

from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import RoomDB, WhiteboardStateDB, ChatMessageDB
from ..room_manager import online_rooms

router = APIRouter(prefix="/api", tags=["房间 & 存档 & 聊天"])


@router.post("/rooms")
async def create_room(data: dict, db: Session = Depends(get_db)):
    name = (data.get("name", "新房间")).strip()[:50]
    room_key = data.get("room_key", uuid.uuid4().hex[:8])

    existing = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
    if existing:
        raise HTTPException(409, "房间Key已存在")

    room = RoomDB(room_key=room_key, name=name, is_public=True)
    db.add(room)
    db.commit()
    db.refresh(room)
    return {"id": room.id, "room_key": room.room_key, "name": room.name}


@router.get("/rooms")
async def list_rooms_api():
    return {
        "rooms": [
            {"id": rid, "users": r.user_count(), "objects": len(r.drawing_objects)}
            for rid, r in online_rooms.items() if r.user_count() > 0
        ]
    }


@router.get("/rooms/{room_key}/states")
async def list_states(room_key: str, db: Session = Depends(get_db)):
    room = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
    if not room:
        return {"states": []}
    states = (
        db.query(WhiteboardStateDB)
        .filter(WhiteboardStateDB.room_id == room.id)
        .order_by(WhiteboardStateDB.updated_at.desc())
        .limit(20)
        .all()
    )
    return {"states": [
        {"id": s.id, "name": s.name, "created_at": s.created_at.isoformat() if s.created_at else None}
        for s in states
    ]}


@router.get("/states/{state_id}")
async def get_state(state_id: int, db: Session = Depends(get_db)):
    state = db.query(WhiteboardStateDB).filter(WhiteboardStateDB.id == state_id).first()
    if not state:
        raise HTTPException(404, "存档不存在")
    return {
        "id": state.id,
        "name": state.name,
        "drawing_data": json.loads(state.drawing_data or "[]"),
    }


@router.get("/rooms/{room_key}/messages")
async def get_messages(room_key: str, limit: int = 50, db: Session = Depends(get_db)):
    room = db.query(RoomDB).filter(RoomDB.room_key == room_key).first()
    if not room:
        return {"messages": []}
    msgs = (
        db.query(ChatMessageDB)
        .filter(ChatMessageDB.room_id == room.id)
        .order_by(ChatMessageDB.created_at.desc())
        .limit(limit)
        .all()
    )
    return {"messages": [
        {
            "id": m.id,
            "userId": m.user_id,
            "username": m.username,
            "nickname": m.nickname,
            "content": m.content,
            "created_at": m.created_at.isoformat() if m.created_at else None,
        }
        for m in reversed(msgs)
    ]}
