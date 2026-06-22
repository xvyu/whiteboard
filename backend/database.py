"""
协作白板 V2 - 数据库引擎与 Session
"""

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, declarative_base

from .config import DATABASE_URL

# PostgreSQL 引擎
# 连接池: 5个连接起步，最多20个，超过10秒空闲的连接会被回收
engine = create_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=15,
    pool_pre_ping=True,
    pool_recycle=3600,
)

Base = declarative_base()


def get_db():
    """获取数据库 Session（FastAPI 依赖注入）"""
    db = Session(engine, expire_on_commit=False)
    try:
        yield db
    finally:
        db.close()
