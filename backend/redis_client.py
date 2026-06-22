"""
协作白板 V2 - Redis 客户端（带内存回退）
支持画板状态缓存与快速读写
"""

import json
import time
import logging
from typing import Optional, Any

logger = logging.getLogger("whiteboard-v2")

# 全局内存缓存（当 Redis 不可用时的回退）
_memory_cache: dict[str, Any] = {}
_memory_ttl: dict[str, float] = {}
_DEFAULT_TTL = 3600  # 1 hour


class RedisClient:
    """Redis 客户端封装，连接失败时自动降级为内存缓存"""

    def __init__(self, host="localhost", port=6379, db=0, password=None):
        self._redis = None
        self._enabled = False
        self._host = host
        self._port = port
        self._password = password
        self._db = db
        self._try_connect()

    def _try_connect(self):
        try:
            import redis as _redis
            pool = _redis.ConnectionPool(
                host=self._host, port=self._port, db=self._db,
                password=self._password, decode_responses=True,
                socket_connect_timeout=2, socket_timeout=2,
                protocol=2,
            )
            self._redis = _redis.Redis(connection_pool=pool)
            self._redis.ping()
            self._enabled = True
            logger.info(f"[Redis] 已连接到 {self._host}:{self._port}")
        except Exception as e:
            self._enabled = False
            self._redis = None
            logger.warning(f"[Redis] 连接失败，使用内存缓存回退: {e}")

    @property
    def available(self) -> bool:
        return self._enabled

    def get(self, key: str) -> Optional[str]:
        if self._enabled and self._redis:
            try:
                return self._redis.get(key)
            except Exception:
                self._enabled = False
        # 内存回退
        val = _memory_cache.get(key)
        if val is None:
            return None
        ttl = _memory_ttl.get(key, 0)
        if ttl > 0 and time.time() > ttl:
            _memory_cache.pop(key, None)
            _memory_ttl.pop(key, None)
            return None
        return val

    def set(self, key: str, value: str, ttl: int = _DEFAULT_TTL):
        if self._enabled and self._redis:
            try:
                self._redis.setex(key, ttl, value)
                return
            except Exception:
                self._enabled = False
        # 内存回退
        _memory_cache[key] = value
        _memory_ttl[key] = time.time() + ttl if ttl > 0 else 0

    def delete(self, key: str):
        if self._enabled and self._redis:
            try:
                self._redis.delete(key)
                return
            except Exception:
                self._enabled = False
        _memory_cache.pop(key, None)
        _memory_ttl.pop(key, None)

    def get_json(self, key: str) -> Any:
        val = self.get(key)
        if val:
            try:
                return json.loads(val)
            except json.JSONDecodeError:
                return None
        return None

    def set_json(self, key: str, obj: Any, ttl: int = _DEFAULT_TTL):
        self.set(key, json.dumps(obj, ensure_ascii=False, default=str), ttl)


# 全局单例
redis_client = RedisClient()

# 缓存键常量
def room_key(room_id: str) -> str:
    return f"room:canvas:{room_id}"

def room_info_key(room_id: str) -> str:
    return f"room:info:{room_id}"
