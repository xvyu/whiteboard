"""
在线协作白板 V2 - 主入口
技术栈: FastAPI + SQLAlchemy (PostgreSQL) + JWT 认证 + 聊天 + 画板持久化
"""

import asyncio
import time
import logging
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

import os
from .config import FRONTEND_DIST, SECRET_KEY
from .database import engine, Base
from .auth import verify_token
from .room_manager import online_rooms

# ========================== 日志配置（必须在 import routers 之前，确保 Redis 日志可见） ==========================
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("whiteboard-v2")

from .routers import auth as auth_router, rooms as rooms_router, websocket as ws_router
from .scheduler import take_snapshots, restore_all_rooms

# ========================== 创建数据库表 ==========================
Base.metadata.create_all(bind=engine)

# ========================== 房间清理任务 ==========================
async def cleanup_inactive_rooms():
    CLEANUP_INTERVAL = 300
    INACTIVE_TIMEOUT = 1800
    while True:
        await asyncio.sleep(CLEANUP_INTERVAL)
        now = time.time()
        to_remove = []
        for key, room in online_rooms.items():
            if room.is_empty() and (now - room.last_active) > INACTIVE_TIMEOUT:
                to_remove.append(key)
        for key in to_remove:
            del online_rooms[key]
            logger.info(f"[清理] 已清理空房间: {key}")


# ========================== FastAPI 应用 ==========================
@asynccontextmanager
async def lifespan(app: FastAPI):
    # 启动时恢复画板状态
    restored = restore_all_rooms()
    if restored > 0:
        logger.info(f"[启动] 已从数据库恢复 {restored} 个房间的画板状态")

    # 启动定时任务
    asyncio.create_task(cleanup_inactive_rooms())
    asyncio.create_task(take_snapshots())
    logger.info("[系统] 协作白板 V2 已启动")
    yield


app = FastAPI(
    title="协作白板 V2",
    description="在线协作白板 - 支持认证、聊天、持久化",
    version="2.0.0",
    lifespan=lifespan,
)

# CORS：生产环境必须设置 WHITEBOARD_ALLOWED_ORIGINS 环境变量（逗号分隔）
# 开发环境下默认允许 localhost，但绝不使用 allow_origins=["*"] + allow_credentials=True
_allowed_origins_str = os.environ.get("WHITEBOARD_ALLOWED_ORIGINS", "")
if _allowed_origins_str:
    ALLOWED_ORIGINS = [o.strip() for o in _allowed_origins_str.split(",") if o.strip()]
else:
    # 开发模式默认值
    ALLOWED_ORIGINS = [
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        "http://localhost:5173",  # Vite dev server
    ]
    import logging as _log
    _log.getLogger("whiteboard-v2").warning(
        "[安全] WHITEBOARD_ALLOWED_ORIGINS 环境变量未设置，"
        "使用开发默认值。生产环境请配置该变量！"
    )

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ========================== 注册路由 ==========================
app.include_router(auth_router.router)
app.include_router(rooms_router.router)
app.include_router(ws_router.router)


# ========================== HTTP 页面路由 ==========================
@app.get("/")
async def root():
    return FileResponse(str(FRONTEND_DIST / "login.html"))


@app.get("/whiteboard")
async def whiteboard_page():
    # 白板页面本身会在 JS 中检查 localStorage 的 token
    # 无需在服务端拦截，直接返回页面即可
    return FileResponse(str(FRONTEND_DIST / "whiteboard.html"))


@app.get("/health")
async def health_check():
    return {
        "status": "ok",
        "rooms": len(online_rooms),
        "total_users": sum(r.user_count() for r in online_rooms.values()),
        "version": "2.0.0",
        "timestamp": datetime.now().isoformat(),
    }


# ========================== 静态文件（Vite 构建产物） ==========================
# 确保静态资源目录存在
assets_dir = FRONTEND_DIST / "assets"
assets_dir.mkdir(parents=True, exist_ok=True)

# 挂载 Vite 的 CSS/JS 资源目录
app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="assets")


# ========================== 忽略 favicon.ico 等无害的日志噪音 ==========================
@app.get("/favicon.ico", include_in_schema=False)
async def favicon_ignore():
    return FileResponse(str(FRONTEND_DIST / "favicon.ico"), status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True, log_level="info")
