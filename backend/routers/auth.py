"""
协作白板 V2 - 认证路由 (注册/登录/获取用户)
"""

from fastapi import APIRouter, HTTPException, Request, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import UserDB
from ..config import USER_COLORS
from ..auth import create_access_token, verify_password, get_password_hash, verify_token

router = APIRouter(prefix="/api", tags=["认证"])


@router.post("/register")
async def register(data: dict, db: Session = Depends(get_db)):
    username = (data.get("username", "")).strip()
    password = (data.get("password", "")).strip()
    nickname = (data.get("nickname", username)).strip()[:20]

    if len(username) < 2 or len(password) < 4:
        raise HTTPException(400, "用户名至少2位，密码至少4位")

    existing = db.query(UserDB).filter(UserDB.username == username).first()
    if existing:
        raise HTTPException(409, "用户名已存在")

    user = UserDB(
        username=username,
        password_hash=get_password_hash(password),
        nickname=nickname,
        avatar_color=USER_COLORS[len(username) % len(USER_COLORS)],
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    token = create_access_token({"sub": str(user.id), "username": user.username})
    return {
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "nickname": user.nickname,
            "color": user.avatar_color,
        }
    }


@router.post("/login")
async def login(data: dict, db: Session = Depends(get_db)):
    username = (data.get("username", "")).strip()
    password = (data.get("password", "")).strip()

    user = db.query(UserDB).filter(UserDB.username == username).first()
    if not user or not verify_password(password, user.password_hash):
        raise HTTPException(401, "用户名或密码错误")

    token = create_access_token({"sub": str(user.id), "username": user.username})
    return {
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "nickname": user.nickname or user.username,
            "color": user.avatar_color,
        }
    }


@router.get("/me")
async def get_me(request: Request, db: Session = Depends(get_db)):
    token = request.headers.get("Authorization", "").replace("Bearer ", "")
    if not token:
        token = request.query_params.get("token", "")
    payload = verify_token(token)
    if not payload:
        raise HTTPException(401, "未登录")

    user = db.query(UserDB).filter(UserDB.id == int(payload["sub"])).first()
    if not user:
        raise HTTPException(404, "用户不存在")
    return {
        "id": user.id,
        "username": user.username,
        "nickname": user.nickname or user.username,
        "color": user.avatar_color,
    }
