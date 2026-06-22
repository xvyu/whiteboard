# 协作白板 V2 - 项目文档

在线多人实时协作白板，支持绘图、聊天、画板持久化。

## 技术栈

- **后端**: FastAPI + SQLAlchemy (PostgreSQL) + WebSocket + JWT 认证 + APScheduler 定时任务
- **前端**: Vite + 原生 JavaScript + Canvas 2D API
- **数据库**: PostgreSQL 12+（主存储）+ Redis 5.x（缓存/会话/支付临时存储）
- **认证**: JWT（python-jose）+ bcrypt 密码哈希
- **部署**: 支持 start.bat 一键启动，依赖 frp 内网穿透可对外访问

## 数据库设计（5张表）

| 表名 | 说明 | 核心字段 |
|------|------|----------|
| `users` | 用户信息 | id(PK), username, password_hash, nickname, avatar_color, created_at |
| `rooms` | 房间信息 | id(PK), room_key, name, owner_id(FK), password, is_public, created_at |
| `whiteboard_states` | 画板实时状态 | id(PK), room_id(FK), drawing_data(JSON), created_at, updated_at |
| `canvas_snapshots` | 画板定时快照 | id(PK), room_id(FK), drawing_data(JSON), object_count, created_at |
| `chat_messages` | 聊天消息 | id(PK), room_id(FK), user_id(FK), content, nickname, user_color, created_at |

### 实体关系

```
用户 (n) ———— 创建/加入 ———— (m) 房间
用户 (1) ———— 发送 ———— (n) 聊天消息
房间 (1) ———— 包含 ———— (1) 画板状态
房间 (1) ———— 生成 ———— (n) 画板快照
房间 (1) ———— 包含 ———— (n) 聊天消息
```

## 项目结构

```
WSCW_4/
├── backend/                   # FastAPI 后端
│   ├── main.py                # 应用入口 & HTTP 路由
│   ├── config.py              # 配置常量（数据库路径、JWT密钥等）
│   ├── database.py            # 数据库引擎 & Session
│   ├── models.py              # SQLAlchemy 数据模型
│   ├── auth.py                # JWT 认证 & 密码处理
│   ├── room_manager.py        # 在线房间管理器 & WebSocket 广播
│   └── routers/
│       ├── auth.py            # 注册/登录/获取用户 API
│       ├── rooms.py           # 房间/存档/聊天消息 API
│       └── websocket.py       # WebSocket 实时协作端点
├── frontend/                  # Vite 前端
│   ├── package.json
│   ├── vite.config.js         # Vite 多页面配置
│   ├── login.html             # 登录/注册页面
│   ├── whiteboard.html        # 白板主页面
│   ├── src/
│   │   ├── login/
│   │   │   ├── main.js        # 登录页逻辑
│   │   │   └── style.css      # 登录页样式
│   │   └── whiteboard/
│   │       ├── main.js        # 白板核心逻辑
│   │       └── style.css      # 白板样式
│   └── dist/                  # 构建产物（npm run build 后生成）
├── docs/                      # 项目文档
├── requirements.txt           # Python 依赖
├── start.bat                  # HTTP 启动脚本
└── start_https.bat            # HTTPS 启动脚本
```

## 数据库初始化

### 前提条件

- PostgreSQL 12+ 已安装并运行
- Redis 5.x 已安装并运行（默认 localhost:6379）

### 创建数据库

```bash
# 进入 PostgreSQL 命令行
psql -U postgres

# 创建数据库
CREATE DATABASE whiteboard_v2;

# 退出
\q

# 导入表结构
psql -U postgres -d whiteboard_v2 -f docs/whiteboard_v2.sql
```

### 数据库配置

在 `start.bat` 或环境变量中配置：

```bash
# 数据库连接
DATABASE_URL=postgresql://用户名:密码@localhost:5432/whiteboard_v2

# Redis 连接
REDIS_URL=redis://localhost:6379/0
```

## 快速开始

### 1. 安装 Python 依赖

```bash
pip install -r requirements.txt
```

### 2. 安装前端依赖（首次）

```bash
cd frontend
npm install
```

### 3. 构建前端

```bash
cd frontend
npm run build
```

### 4. 启动服务

**方式一：使用启动脚本**
```bash
start.bat       # HTTP 模式
start_https.bat # HTTPS 模式
```

**方式二：手动启动**
```bash
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

### 5. 访问

- 浏览器打开 `http://localhost:8000`
- 注册账号或使用游客模式进入

## 开发模式

### 后端热重载
```bash
python -m uvicorn backend.main:app --reload --host 0.0.0.0 --port 8000
```

### 前端热重载（Vite Dev Server）
```bash
cd frontend
npm run dev
```
Vite 开发服务器自动代理 API 请求到后端（端口 8000）。

## API 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/register` | 用户注册 |
| POST | `/api/login` | 用户登录 |
| GET | `/api/me` | 获取当前用户信息 |
| POST | `/api/rooms` | 创建房间 |
| GET | `/api/rooms` | 在线房间列表 |
| GET | `/api/rooms/{room_key}/states` | 获取房间存档列表 |
| GET | `/api/states/{state_id}` | 获取存档内容 |
| GET | `/api/rooms/{room_key}/messages` | 获取聊天记录 |
| WS | `/ws/{room_key}` | WebSocket 实时协作 |
| GET | `/` | 登录页面 |
| GET | `/whiteboard` | 白板页面（需登录 token） |
| GET | `/health` | 健康检查 |

## WebSocket 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `add` | 双向 | 添加图形 |
| `modify` | 双向 | 修改图形 |
| `remove` | 双向 | 删除图形 |
| `clear` | 双向 | 清空画板 |
| `undo` | 双向 | 撤销 |
| `chat` | 双向 | 聊天消息 |
| `save_state` | 客户端→服务端 | 保存画板 |
| `load_state` | 客户端→服务端 | 加载存档 |
| `cursor_move` | 双向 | 光标移动同步 |
| `init` | 服务端→客户端 | 初始化连接 |
| `full_state` | 双向 | 全量画板状态 |
| `user_joined` / `user_left` | 服务端→客户端 | 用户进出通知 |

## 版本

- v2.0.0 - 前后端分离重构
