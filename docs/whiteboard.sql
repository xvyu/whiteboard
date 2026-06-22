-- ========================================
-- 协作白板 V2 - 数据库初始化脚本
-- 数据库: PostgreSQL 12+
-- ========================================

-- 创建数据库（需在 psql 中以超级用户执行）
-- CREATE DATABASE whiteboard_v2
--     WITH ENCODING 'UTF8'
--     LC_COLLATE = 'C'
--     LC_CTYPE = 'C';

-- 使用数据库
-- \c whiteboard_v2

-- ========================================
-- 1. 用户信息表 (users)
-- ========================================
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL          PRIMARY KEY,
    username        VARCHAR(50)     NOT NULL UNIQUE,
    password_hash   VARCHAR(255)    NOT NULL,
    nickname        VARCHAR(100)    DEFAULT '',
    avatar_color    VARCHAR(7)      DEFAULT '#4A90D9',
    created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

COMMENT ON TABLE  users                IS '用户信息表';
COMMENT ON COLUMN users.id             IS '用户ID，自增主键';
COMMENT ON COLUMN users.username       IS '用户名，唯一';
COMMENT ON COLUMN users.password_hash  IS '密码哈希值（bcrypt加密）';
COMMENT ON COLUMN users.nickname       IS '用户昵称';
COMMENT ON COLUMN users.avatar_color   IS '用户颜色标识';
COMMENT ON COLUMN users.created_at     IS '注册时间';

-- ========================================
-- 2. 房间信息表 (rooms)
-- ========================================
CREATE TABLE IF NOT EXISTS rooms (
    id              SERIAL          PRIMARY KEY,
    room_key        VARCHAR(100)    NOT NULL UNIQUE,
    name            VARCHAR(100)    NOT NULL,
    owner_id        INTEGER         REFERENCES users(id) ON DELETE SET NULL,
    password        VARCHAR(255)    DEFAULT NULL,
    is_public       BOOLEAN         DEFAULT TRUE,
    created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rooms_room_key ON rooms(room_key);

COMMENT ON TABLE  rooms                IS '房间信息表';
COMMENT ON COLUMN rooms.id             IS '房间ID，自增主键';
COMMENT ON COLUMN rooms.room_key       IS '房间唯一标识（URL友好）';
COMMENT ON COLUMN rooms.name           IS '房间名称';
COMMENT ON COLUMN rooms.owner_id       IS '房主用户ID，外键关联users';
COMMENT ON COLUMN rooms.password       IS '房间访问密码（可选，bcrypt加密）';
COMMENT ON COLUMN rooms.is_public      IS '是否公开可见';
COMMENT ON COLUMN rooms.created_at     IS '创建时间';
COMMENT ON COLUMN rooms.updated_at     IS '最后更新时间';

-- ========================================
-- 3. 画板状态表 (whiteboard_states)
-- ========================================
CREATE TABLE IF NOT EXISTS whiteboard_states (
    id              SERIAL          PRIMARY KEY,
    room_id         INTEGER         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id         INTEGER         REFERENCES users(id) ON DELETE SET NULL,
    name            VARCHAR(100)    DEFAULT '未命名',
    drawing_data    TEXT            DEFAULT '[]',
    created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_whiteboard_states_room_id ON whiteboard_states(room_id);

COMMENT ON TABLE  whiteboard_states              IS '画板状态表（实时绘图数据）';
COMMENT ON COLUMN whiteboard_states.id           IS '状态ID，自增主键';
COMMENT ON COLUMN whiteboard_states.room_id      IS '所属房间ID，外键关联rooms';
COMMENT ON COLUMN whiteboard_states.user_id      IS '创建用户ID，外键关联users';
COMMENT ON COLUMN whiteboard_states.name         IS '状态名称';
COMMENT ON COLUMN whiteboard_states.drawing_data IS '序列化绘图对象JSON数组';
COMMENT ON COLUMN whiteboard_states.created_at   IS '创建时间';
COMMENT ON COLUMN whiteboard_states.updated_at   IS '最后修改时间';

-- ========================================
-- 4. 画板快照表 (canvas_snapshots)
-- ========================================
CREATE TABLE IF NOT EXISTS canvas_snapshots (
    id              SERIAL          PRIMARY KEY,
    room_id         INTEGER         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    drawing_data    TEXT            DEFAULT '[]',
    object_count    INTEGER         DEFAULT 0,
    created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_canvas_snapshots_room_id ON canvas_snapshots(room_id);

COMMENT ON TABLE  canvas_snapshots              IS '画板快照表（定时备份）';
COMMENT ON COLUMN canvas_snapshots.id           IS '快照ID，自增主键';
COMMENT ON COLUMN canvas_snapshots.room_id      IS '所属房间ID，外键关联rooms';
COMMENT ON COLUMN canvas_snapshots.drawing_data IS '完整画板数据JSON';
COMMENT ON COLUMN canvas_snapshots.object_count IS '绘图对象数量';
COMMENT ON COLUMN canvas_snapshots.created_at   IS '快照创建时间';

-- ========================================
-- 5. 聊天消息表 (chat_messages)
-- ========================================
CREATE TABLE IF NOT EXISTS chat_messages (
    id              SERIAL          PRIMARY KEY,
    room_id         INTEGER         NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id         INTEGER         REFERENCES users(id) ON DELETE SET NULL,
    username        VARCHAR(50)     DEFAULT '',
    nickname        VARCHAR(100)    DEFAULT '',
    user_color      VARCHAR(7)      DEFAULT '#999',
    content         TEXT            NOT NULL,
    created_at      TIMESTAMP       DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_id ON chat_messages(room_id);

COMMENT ON TABLE  chat_messages              IS '聊天消息表';
COMMENT ON COLUMN chat_messages.id           IS '消息ID，自增主键';
COMMENT ON COLUMN chat_messages.room_id      IS '所属房间ID，外键关联rooms';
COMMENT ON COLUMN chat_messages.user_id      IS '发送用户ID，外键关联users';
COMMENT ON COLUMN chat_messages.username     IS '发送者用户名';
COMMENT ON COLUMN chat_messages.nickname     IS '发送者昵称';
COMMENT ON COLUMN chat_messages.user_color   IS '发送者颜色';
COMMENT ON COLUMN chat_messages.content      IS '消息内容';
COMMENT ON COLUMN chat_messages.created_at   IS '发送时间';
