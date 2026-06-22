"""
协作白板 V2 - 配置常量
"""

import os
import secrets
from pathlib import Path

# 项目根目录（backend/ 的上一级）
PROJECT_ROOT = Path(__file__).parent.parent

# PostgreSQL 数据库配置（通过 psycopg2 连接）
DATABASE_URL = "postgresql://postgres:450881@localhost:5432/whiteboard_v2"

# JWT 配置 — 优先从环境变量读取，未设置则使用随机密钥（每次重启后旧 Token 失效）
SECRET_KEY = os.environ.get("WHITEBOARD_SECRET_KEY", "")
if not SECRET_KEY:
    SECRET_KEY = secrets.token_hex(32)
    import logging
    logging.getLogger("whiteboard-v2").warning(
        "[安全] WHITEBOARD_SECRET_KEY 环境变量未设置，已生成临时密钥。"
        "重启后所有已颁发的 Token 将失效。生产环境请设置该环境变量！"
    )
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7天

# 用户颜色池
USER_COLORS = [
    "#FF6B6B", "#4ECDC4", "#45B7D1", "#96CEB4",
    "#FFEAA7", "#DDA0DD", "#F7DC6F", "#98D8C8",
    "#BB8FCE", "#85C1E9", "#F8C471", "#82E0AA",
    "#F1948A", "#AED6F1", "#D7BDE2", "#A3E4D7",
    "#E74C3C", "#3498DB", "#2ECC71", "#F39C12",
]

# 前端构建产物目录
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
