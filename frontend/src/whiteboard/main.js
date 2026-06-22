import './style.css'

// ==================== 全局状态 ====================
const STATE = {
  tool: 'pen',
  color: '#333333',
  size: 3,
  objects: [],
  history: [],
  redoHistory: [],
  maxHistory: 200,
  userId: null,
  userColor: '#4A90D9',
  nickname: '匿名用户',
  wsKey: null,
  ws: null,
  mode: 'local', // 'ws' | 'local' | 'offline'
  roomKey: '',
  roomPassword: '',
  token: '',
  msgQueue: [], // 等待 WS 连接时暂存的消息队列
  _pendingOps: [], // 已发送但未收到服务端确认的操作 { type, data, id }
  _lastDrawTime: 0, // 最后一次绘制/修改操作的时间戳，用于动态同步间隔
  // 缩放平移
  scale: 1, offsetX: 0, offsetY: 0,
  isPanning: false, panStart: null,
  showGrid: true,
  // 绘制状态
  isDrawing: false, drawStart: null, currentObj: null,
  // 选择
  selectedObj: null, dragOffset: null, isDragging: false,
  // 填充
  fillImageData: null,
  // 橡皮擦待移除对象ID集合（拖动时预览，松开时正式移除）
  pendingEraseIds: new Set(),
  // 远程光标
  remoteCursors: {},
  // 用户列表
  users: {},
}

// ==================== DOM 引用（延迟初始化） ====================
let mainCanvas, tempCanvas, mainCtx, tempCtx, canvasWrap

function initDOMReferences() {
  mainCanvas = document.getElementById('mainCanvas')
  tempCanvas = document.getElementById('tempCanvas')
  mainCtx = mainCanvas.getContext('2d')
  tempCtx = tempCanvas.getContext('2d')
  canvasWrap = document.getElementById('canvasWrap')
}

// ==================== 初始化 ====================
function init() {
  initDOMReferences()
  const params = new URLSearchParams(window.location.search)
  STATE.token = localStorage.getItem('wb_token') || ''

  const userStr = localStorage.getItem('wb_user')
  if (userStr) {
    try {
      const u = JSON.parse(userStr)
      STATE.nickname = u.nickname || u.username
      STATE.userId = u.id
      STATE.userColor = u.color || '#4A90D9'
    } catch (e) {}
  }

  resizeCanvas()
  window.addEventListener('resize', resizeCanvas)
  // 确保 CSS 布局完成后再校正一次画布尺寸（避免初始 clientWidth 为 0）
  window.addEventListener('load', resizeCanvas)
  requestAnimationFrame(() => requestAnimationFrame(resizeCanvas))
  setupToolbar()
  setupCanvasEvents()
  setupSidePanel()

  // 绑定输入框回车事件
  document.getElementById('roomInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom()
  })
  document.getElementById('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendChat()
  })

  // 如果 URL 带了房间号，直接连接；否则检查 localStorage 中的房间信息，实现刷新自动重连
  const roomParam = params.get('room')
  const passwordParam = params.get('password')
  if (roomParam) {
    STATE.roomKey = roomParam
    if (passwordParam) STATE.roomPassword = passwordParam
    document.getElementById('roomOverlay').style.display = 'none'
    connect()
  } else {
    // 检查 localStorage 是否有缓存的房间（用于页面刷新后自动重连）
    const savedRoom = localStorage.getItem('wb_room_key')
    if (savedRoom) {
      STATE.roomKey = savedRoom
      STATE.roomPassword = localStorage.getItem('wb_room_password') || ''
      document.getElementById('roomOverlay').style.display = 'none'
      connect()
    } else {
      showRoomDialog()
    }
  }
}

function resizeCanvas() {
  const w = canvasWrap.clientWidth
  const h = canvasWrap.clientHeight
  if (w === 0 || h === 0) {
    // 布局尚未完成，跳过本次 resize，等待下次调用
    return
  }
  ;[mainCanvas, tempCanvas].forEach(c => { c.width = w; c.height = h })
  renderAll()
}

// ==================== 连接管理 ====================
function connect() {
  updateStatus('connecting')
  // 尝试 WebSocket
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const wsHost = window.location.host || 'localhost:8000'
  const roomPassword = STATE.roomPassword || ''
  let wsUrl = `${protocol}//${wsHost}/ws/${STATE.roomKey}?nickname=${encodeURIComponent(STATE.nickname)}` +
    (STATE.token ? `&token=${STATE.token}` : '') +
    (roomPassword ? `&password=${encodeURIComponent(roomPassword)}` : '')

  let wsRetry = 0
  function tryWS() {
    if (wsRetry >= 3) { fallbackToLocal(); return }
    const ws = new WebSocket(wsUrl)
    const timeout = setTimeout(() => { ws.close(); wsRetry++; tryWS() }, 4000)

    ws.onopen = () => {
      clearTimeout(timeout)
      STATE.ws = ws
      STATE.mode = 'ws'
      updateStatus('online')
      setupWS(ws)
    }
    ws.onerror = () => { clearTimeout(timeout); wsRetry++; setTimeout(tryWS, 1000) }
  }
  tryWS()
}

// ==================== 房间选择 ====================
function showRoomDialog() {
  document.getElementById('roomOverlay').style.display = 'flex'
  document.getElementById('roomInput').focus()
  document.getElementById('roomError').textContent = ''
  // 显示当前用户信息
  const userInfo = document.getElementById('roomUserInfo')
  if (userInfo) {
    userInfo.textContent = '当前用户: ' + (STATE.nickname || '匿名用户')
  }
}

function generateRoom() {
  const room = 'room_' + Math.random().toString(36).slice(2, 8)
  document.getElementById('roomInput').value = room
}

function joinRoom() {
  const input = document.getElementById('roomInput')
  const room = input.value.trim()
  const err = document.getElementById('roomError')
  const pwdInput = document.getElementById('roomPassword')

  if (!room) {
    // 没填就随机生成
    STATE.roomKey = 'room_' + Math.random().toString(36).slice(2, 8)
  } else if (/^[a-zA-Z0-9_\-]+$/.test(room)) {
    STATE.roomKey = room
  } else {
    err.textContent = '房间号只能包含字母、数字、下划线和横线'
    return
  }

  STATE.roomPassword = pwdInput ? pwdInput.value.trim() : ''

  // 将房间信息保存到 localStorage（页面刷新后自动重连）
  localStorage.setItem('wb_room_key', STATE.roomKey)
  if (STATE.roomPassword) {
    localStorage.setItem('wb_room_password', STATE.roomPassword)
  } else {
    localStorage.removeItem('wb_room_password')
  }

  // 隐藏遮罩并连接
  document.getElementById('roomOverlay').style.display = 'none'
  document.getElementById('roomInfo').textContent = `房间: ${STATE.roomKey}`
  connect()
}

function fallbackToLocal() {
  STATE.mode = 'local'
  updateStatus('local')
  setupBroadcastChannel()
  toast('📡 未检测到服务器，使用本机协作模式')
}

function setupBroadcastChannel() {
  try {
    const bc = new BroadcastChannel('whiteboard_' + STATE.roomKey)
    bc.onmessage = (e) => {
      const msg = e.data
      if (msg.source === STATE.wsKey) return
      handleRemoteMessage(msg)
    }
    STATE.bc = bc
    STATE.wsKey = 'local_' + Math.random().toString(36).slice(2, 8)
    // 同步加入
    bc.postMessage({ type: 'user_joined', userId: STATE.wsKey, nickname: STATE.nickname, color: STATE.userColor, source: STATE.wsKey, onlineCount: 1 })
    bc.postMessage({ type: 'init', objects: STATE.objects, userId: STATE.wsKey, source: STATE.wsKey })
  } catch (e) {
    STATE.mode = 'offline'
    updateStatus('offline')
  }
}

function setupWS(ws) {
  ws.onmessage = (e) => {
    try { handleRemoteMessage(JSON.parse(e.data)) } catch (ex) {}
  }
  ws.onclose = () => {
    if (STATE.mode === 'ws') {
      STATE.mode = 'local'
      updateStatus('local')
      setupBroadcastChannel()
      toast('⚠️ 服务器断开，已切换到本机模式')
    }
  }

  // 清空消息队列（WS 连接刚建立，旧队列中的绘图消息已过时，无需重发）
  STATE.msgQueue = []
  console.log('[setupWS] Queue cleared on new WS connection')

  // 画板固定 0.5s 同步一次，确保协作实时性
  if (STATE._syncTimer) clearInterval(STATE._syncTimer)
  STATE._syncTimer = setInterval(() => {
    if (STATE.mode === 'ws' && STATE.ws && STATE.ws.readyState === 1) {
      send({ type: 'request_state' })
    }
  }, 500)

  // 定时重发待确认操作（每 3 秒检查一次，防止 frp 丢包导致操作丢失）
  if (STATE._pendingRetryTimer) clearInterval(STATE._pendingRetryTimer)
  STATE._pendingRetryTimer = setInterval(() => {
    retryPendingOps()
  }, 3000)
}

function send(msg) {
  if (STATE.mode === 'ws' && STATE.ws && STATE.ws.readyState === 1) {
    STATE.ws.send(JSON.stringify(msg))
  } else if (STATE.bc) {
    msg.source = STATE.wsKey
    STATE.bc.postMessage(msg)
  } else if (msg.type === 'save_state' || msg.type === 'load_state' || msg.type === 'list_states') {
    // 离线/本地模式：使用 localStorage 作为存档回退
    handleLocalStateAction(msg)
  } else if (msg.type !== 'cursor_move' && msg.type !== 'pong') {
    // WS 未连接时，将关键消息加入队列，连接后自动重发
    STATE.msgQueue.push(msg)
    if (STATE.msgQueue.length === 1) {
      console.log('[send] WS not ready, queuing message:', msg.type)
    }
  }
}

// ==================== 待确认操作自动重发（防止 frp 丢包） ====================
function retryPendingOps() {
  if (STATE._pendingOps.length === 0) return
  if (!STATE.ws || STATE.ws.readyState !== 1) return

  const now = Date.now()
  const expired = STATE._pendingOps.filter(op => now - op.time > 2000) // 超过 2 秒未确认
    
  if (expired.length === 0) return
  console.log(`[重发] 重发 ${expired.length} 个待确认操作`)
    
  for (const op of expired) {
    op.time = now // 更新时间戳
    if (op.type === 'add') {
      STATE.ws.send(JSON.stringify({ type: 'add', data: op.data }))
    } else if (op.type === 'modify') {
      STATE.ws.send(JSON.stringify({ type: 'modify', id: op.id, changes: op.changes }))
    } else if (op.type === 'remove') {
      STATE.ws.send(JSON.stringify({ type: 'remove', id: op.id }))
    } else if (op.type === 'clear') {
      STATE.ws.send(JSON.stringify({ type: 'clear' }))
    }
  }
}

// ==================== 本地存档（离线/本机模式回退） ====================
function getLocalSavesKey() {
  return 'wb_saves_' + (STATE.roomKey || 'default')
}

function getLocalSaves() {
  try {
    const data = localStorage.getItem(getLocalSavesKey())
    return data ? JSON.parse(data) : []
  } catch (e) {
    return []
  }
}

function setLocalSaves(saves) {
  try {
    localStorage.setItem(getLocalSavesKey(), JSON.stringify(saves))
  } catch (e) {
    toast('⚠️ 本地存储空间不足，无法保存存档')
  }
}

function handleLocalStateAction(msg) {
  if (msg.type === 'save_state') {
    const name = (msg.name || '存档').trim()
    const saves = getLocalSaves()
    const newSave = {
      id: Date.now(),
      name: name,
      objects: JSON.parse(JSON.stringify(STATE.objects)),
      created_at: new Date().toISOString()
    }
    saves.unshift(newSave)
    // 最多保留 20 个本地存档
    if (saves.length > 20) saves.length = 20
    setLocalSaves(saves)
    toast('✅ 本地存档「' + name + '」已保存')
    renderStatesList(saves)
  } else if (msg.type === 'load_state') {
    const saves = getLocalSaves()
    const found = saves.find(s => s.id === msg.state_id)
    if (found) {
      STATE.objects = JSON.parse(JSON.stringify(found.objects))
      renderAll()
      toast('📂 已加载本地存档「' + found.name + '」')
    } else {
      toast('⚠️ 未找到该存档')
    }
  } else if (msg.type === 'list_states') {
    renderStatesList(getLocalSaves())
  } else if (msg.type === 'delete_state') {
    deleteLocalState(msg.state_id)
  }
}

function deleteLocalState(id) {
  const saves = getLocalSaves().filter(s => s.id !== id)
  setLocalSaves(saves)
  renderStatesList(saves)
  toast('🗑️ 存档已删除')
}

function handleRemoteMessage(msg) {
  switch (msg.type) {
    case 'init':
      STATE.objects = msg.objects || []
      STATE.users = msg.users || {}
      STATE.wsKey = msg.wsKey || STATE.wsKey
      STATE.ownerKey = msg.ownerKey || null
      if (msg.userId) STATE.userId = msg.userId
      if (msg.userColor) STATE.userColor = msg.userColor
      if (msg.nickname) STATE.nickname = msg.nickname
      // 加载聊天历史
      document.getElementById('chatMessages').innerHTML = '<div class="chat-msg system">欢迎来到协作白板！</div>'
      if (msg.chatHistory) {
        msg.chatHistory.forEach(m => addChatMessage(m))
      }
      renderAll(); updateUserList(); updateOnlineCount(); updateStatus(STATE.mode === 'ws' ? 'online' : STATE.mode)
      break
    case 'add':
      STATE._lastDrawTime = Date.now() // 他人作图 → 加快同步
      STATE.objects.push(msg.data)
      renderAll(); break
    case 'add_ack':
      // 服务端确认已收到此对象，从待确认队列移除
      STATE._pendingOps = STATE._pendingOps.filter(op => !(op.type === 'add' && op.id === msg.id))
      break
    case 'modify_ack':
      STATE._pendingOps = STATE._pendingOps.filter(op => !(op.type === 'modify' && op.id === msg.id))
      break
    case 'remove_ack':
      STATE._pendingOps = STATE._pendingOps.filter(op => !(op.type === 'remove' && op.id === msg.id))
      break
    case 'clear_ack':
      STATE._pendingOps = STATE._pendingOps.filter(op => op.type !== 'clear')
      break
    case 'modify': {
      STATE._lastDrawTime = Date.now() // 他人修改 → 加快同步
      const obj = STATE.objects.find(o => o.id === msg.id)
      if (obj) Object.assign(obj, msg.changes)
      renderAll(); break
    }
    case 'remove':
      STATE._lastDrawTime = Date.now() // 他人删除 → 加快同步
      STATE.objects = STATE.objects.filter(o => o.id !== msg.id)
      renderAll(); break
    case 'clear':
      STATE._lastDrawTime = Date.now() // 他人清空 → 加快同步
      STATE.objects = [];       renderAll(); break
    case 'full_state':
      // ⚠️ 合并而非直接替换：保留本地有但服务端没有的对象（frp隧道丢包保护）
      if (msg.objects) {
        const serverIds = new Set(msg.objects.map(o => o.id))
        const localOnly = STATE.objects.filter(o => !serverIds.has(o.id))
        if (localOnly.length > 0) {
          console.log(`[全量状态] 合并 ${localOnly.length} 个本地未同步对象`)
          STATE.objects = [...msg.objects, ...localOnly]
        } else {
          STATE.objects = msg.objects
        }
      } else {
        STATE.objects = []
      }
      // 同步房主信息和用户列表（避免 frp 丢包导致踢人按钮消失）
      if (msg.ownerKey) {
        STATE.ownerKey = msg.ownerKey
      }
      if (msg.users) {
        STATE.users = {}
        Object.keys(msg.users).forEach(k => {
          const u = msg.users[k]
          STATE.users[k] = { nickname: u.nickname, color: u.color, wsKey: u.wsKey }
        })
      }
      updateUserList(); updateOnlineCount()
      renderAll(); break
    case 'user_joined':
      STATE.users[msg.wsKey || msg.userId] = { nickname: msg.nickname, color: msg.color, wsKey: msg.wsKey }
      // 更新房主信息（可能新房主上任）
      if (msg.ownerKey) STATE.ownerKey = msg.ownerKey
      updateUserList(); updateOnlineCount()
      break
    case 'user_left':
      delete STATE.users[msg.wsKey || msg.userId]
      updateUserList(); updateOnlineCount()
      // 仅在房主确实变更时才更新，防止旧连接的 finally 广播覆盖新房主信息
      if (msg.newOwnerKey && msg.newOwnerKey !== STATE.ownerKey) {
        STATE.ownerKey = msg.newOwnerKey
        updateUserList()
      }
      break
    case 'user_renamed': {
      const uk = msg.userId || msg.wsKey
      if (STATE.users[uk]) STATE.users[uk].nickname = msg.nickname
      updateUserList(); break
    }
    case 'chat':
      // 如果是自己发的消息，跳过（已在 sendChat 中本地添加）
      if (msg.userId && STATE.userId && msg.userId === STATE.userId) break
      addChatMessage(msg); break
    case 'cursor_move':
      STATE.remoteCursors[msg.userId || msg.wsKey] = { x: msg.x, y: msg.y, color: msg.color, nickname: msg.nickname, ts: Date.now() }
      renderRemoteCursors(); break
    case 'state_saved':
      toast('✅ ' + msg.message); refreshStates(); break
    case 'state_deleted':
      toast('✅ ' + msg.message); refreshStates(); break
    case 'chat_deleted':
      removeChatMessage(msg.id); break
    case 'owner_changed':
      STATE.ownerKey = msg.ownerKey
      updateUserList(); break
    case 'kicked':
      toast('⛔ 你已被房主移出房间')
      // 返回房间输入页面而非首页（保留登录状态）
      if (STATE.ws) { try { STATE.ws.close() } catch (e) {} STATE.ws = null }
      STATE.mode = 'local'
      STATE.objects = []
      STATE.users = {}
      STATE._pendingOps = []
      if (STATE._syncTimer) { clearInterval(STATE._syncTimer); STATE._syncTimer = null }
      if (STATE._pendingRetryTimer) { clearInterval(STATE._pendingRetryTimer); STATE._pendingRetryTimer = null }
      setTimeout(() => showRoomDialog(), 1500)
      break
    case 'states_list':
      renderStatesList(msg.states); break
    case 'state_preview':
      console.log('[预览] 收到数据:', msg.state_id, '对象数:', msg.objects ? msg.objects.length : 0)
      renderStatePreview(msg.state_id, msg.objects); break
    case 'ping':
      send({ type: 'pong' }); break
    case 'onlineCount':
      break
    case 'error':
      // 主动断开（如密码错误）：先把模式切成本地，避免 onclose 触发"服务器断开" toast
      STATE.mode = 'local'
      if (msg.message && msg.message.includes('密码')) {
        // 先显示对话框（会清空 roomError），再设置错误消息
        showRoomDialog()
        document.getElementById('roomError').textContent = msg.message
      } else {
        toast('❌ ' + msg.message)
        setTimeout(() => { window.location.href = '/' }, 2000)
      }
      break
  }
}

// ==================== 绘图渲染 ====================
function renderAll() {
  const ctx = mainCtx
  const w = mainCanvas.width, h = mainCanvas.height
  ctx.clearRect(0, 0, w, h)

  // 网格背景
  if (STATE.showGrid) {
    ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 0.5
    const gs = 40
    for (let x = 0; x < w; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
    for (let y = 0; y < h; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke() }
  }

  ctx.save()
  ctx.translate(STATE.offsetX, STATE.offsetY)
  ctx.scale(STATE.scale, STATE.scale)

  for (const obj of STATE.objects) {
    if (STATE.pendingEraseIds.has(obj.id)) continue
    drawObject(ctx, obj)
  }
  ctx.restore()
}

function drawObject(ctx, obj) {
  ctx.save()
  const color = obj.color || obj.userColor || '#333'
  const size = obj.size || 3
  const tool = obj.tool || 'pen'

  if (obj.highlight) {
    // 选中高亮
    ctx.strokeStyle = '#667eea'
    ctx.lineWidth = 2 / STATE.scale
    ctx.setLineDash([5, 3])
    ctx.strokeRect(obj.x - 4, obj.y - 4, (obj.w || 0) + 8, (obj.h || 0) + 8)
    ctx.setLineDash([])
  }

  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = size
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  switch (tool) {
    case 'pen':
      if (obj.points && obj.points.length > 1) {
        ctx.beginPath(); ctx.moveTo(obj.points[0].x, obj.points[0].y)
        for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y)
        ctx.stroke()
      }
      break
    case 'marker':
      ctx.globalAlpha = 0.7
      ctx.lineWidth = size * 1.5
      if (obj.points && obj.points.length > 1) {
        ctx.beginPath(); ctx.moveTo(obj.points[0].x, obj.points[0].y)
        for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y)
        ctx.stroke()
      }
      break
    case 'highlighter':
      ctx.globalAlpha = 0.25
      ctx.lineWidth = size * 3
      if (obj.points && obj.points.length > 1) {
        ctx.beginPath(); ctx.moveTo(obj.points[0].x, obj.points[0].y)
        for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y)
        ctx.stroke()
      }
      break
    case 'rect':
      if (obj.fill) { ctx.globalAlpha = 0.2; ctx.fillRect(obj.x, obj.y, obj.w || 0, obj.h || 0); ctx.globalAlpha = 1 }
      ctx.strokeRect(obj.x, obj.y, obj.w || 0, obj.h || 0)
      break
    case 'circle':
      const rx = (obj.w || 0) / 2, ry = (obj.h || 0) / 2
      const cx = obj.x + rx, cy = obj.y + ry
      ctx.beginPath(); ctx.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2)
      if (obj.fill) { ctx.globalAlpha = 0.2; ctx.fill(); ctx.globalAlpha = 1 }
      ctx.stroke()
      break
    case 'triangle':
      ctx.beginPath()
      ctx.moveTo(obj.x + (obj.w || 0) / 2, obj.y)
      ctx.lineTo(obj.x + (obj.w || 0), obj.y + (obj.h || 0))
      ctx.lineTo(obj.x, obj.y + (obj.h || 0))
      ctx.closePath()
      if (obj.fill) { ctx.globalAlpha = 0.2; ctx.fill(); ctx.globalAlpha = 1 }
      ctx.stroke()
      break
    case 'line':
      ctx.beginPath(); ctx.moveTo(obj.x, obj.y); ctx.lineTo(obj.x2, obj.y2); ctx.stroke()
      break
    case 'arrow':
      drawArrow(ctx, obj.x, obj.y, obj.x2, obj.y2, color, size)
      break
    case 'text':
      ctx.font = `${size * 5}px 'Microsoft YaHei', sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(obj.content || '', obj.x, obj.y)
      break
    case 'fill':
      if (obj.dataUrl) {
        // 缓存 Image 对象，避免每次渲染都重新创建
        if (!obj._img) {
          obj._img = new Image()
          obj._img.src = obj.dataUrl
        }
        if (obj._img.complete) {
          ctx.drawImage(obj._img, obj.x || 0, obj.y || 0, obj.w || 0, obj.h || 0)
        }
      }
      break
  }
  ctx.restore()
}

function drawArrow(ctx, x1, y1, x2, y2, color, size) {
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = size
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke()
  const angle = Math.atan2(y2 - y1, x2 - x1)
  const headLen = 12 + size * 2
  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath(); ctx.fill()
}

function renderRemoteCursors() {
  const ctx = tempCtx
  ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height)
  const now = Date.now()
  for (const [id, c] of Object.entries(STATE.remoteCursors)) {
    if (now - c.ts > 5000) { delete STATE.remoteCursors[id]; continue }
    ctx.fillStyle = c.color || '#999'
    ctx.beginPath()
    ctx.moveTo(c.x, c.y)
    ctx.lineTo(c.x + 10, c.y + 18)
    ctx.lineTo(c.x + 4, c.y + 16)
    ctx.lineTo(c.x + 5, c.y + 24)
    ctx.lineTo(c.x, c.y + 18)
    ctx.closePath()
    ctx.fill()
    ctx.font = '10px sans-serif'
    ctx.fillText(c.nickname || '', c.x + 12, c.y + 16)
  }
}

// ==================== 工具栏 ====================
const PRESET_COLORS = [
  '#333333', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71',
  '#1abc9c', '#3498db', '#9b59b6', '#e91e63', '#795548',
  '#95a5a6', '#ffffff'
]

function buildColorSwatches() {
  const container = document.getElementById('colorSwatches')
  PRESET_COLORS.forEach(c => {
    const dot = document.createElement('div')
    dot.className = 'color-swatch'
    dot.style.backgroundColor = c
    if (c === '#ffffff') dot.style.border = '2px solid #555'
    dot.title = c
    dot.addEventListener('click', () => {
      STATE.color = c
      document.getElementById('colorPicker').value = c
      document.querySelectorAll('.color-swatch').forEach(d => d.classList.remove('active'))
      dot.classList.add('active')
      updateSizePreview()
      updateCrosshair()
    })
    if (c === STATE.color) dot.classList.add('active')
    container.appendChild(dot)
  })
}

function updateSizePreview() {
  const preview = document.getElementById('sizePreview').querySelector('span')
  const s = Math.min(STATE.size, 26)
  preview.style.width = s + 'px'
  preview.style.height = s + 'px'
  preview.style.backgroundColor = STATE.color
}

// 生成带颜色的十字光标 SVG
function getCrosshairCursor(color) {
  // 取反色作为描边，确保在任何背景下都可见
  const r = parseInt(color.slice(1,3), 16)
  const g = parseInt(color.slice(3,5), 16)
  const b = parseInt(color.slice(5,7), 16)
  const outline = (255 - r < 40 && 255 - g < 40 && 255 - b < 40) ? '#ffffff' : 'rgba(255,255,255,0.7)'
  const encodedColor = encodeURIComponent(color)
  const encodedOutline = encodeURIComponent(outline)
  return `url('data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><line x1="12" y1="0" x2="12" y2="24" stroke="${encodedOutline}" stroke-width="3"/><line x1="0" y1="12" x2="24" y2="12" stroke="${encodedOutline}" stroke-width="3"/><line x1="12" y1="0" x2="12" y2="24" stroke="${encodedColor}" stroke-width="1.5"/><line x1="0" y1="12" x2="24" y2="12" stroke="${encodedColor}" stroke-width="1.5"/><circle cx="12" cy="12" r="2.5" fill="${encodedColor}"/></svg>') 12 12, crosshair`
}

function updateCrosshair() {
  if (STATE.tool === 'select' || STATE.tool === 'text' || STATE.tool === 'fill' || STATE.tool === 'eraser') return
  canvasWrap.style.cursor = getCrosshairCursor(STATE.color)
}

function setupToolbar() {
  // 颜色面板
  buildColorSwatches()
  updateSizePreview()

  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => selectTool(btn.dataset.tool))
  })
  document.getElementById('colorPicker').addEventListener('input', e => {
    STATE.color = e.target.value
    document.querySelectorAll('.color-swatch').forEach(d => d.classList.remove('active'))
    updateSizePreview()
    updateCrosshair()
  })
  document.getElementById('colorPicker').value = STATE.color
  document.getElementById('sizeSlider').addEventListener('input', e => {
    STATE.size = parseInt(e.target.value)
    document.getElementById('sizeVal').textContent = STATE.size
    updateSizePreview()
  })
  document.getElementById('btnUndo').addEventListener('click', undo)
  document.getElementById('btnRedo').addEventListener('click', redo)
  document.getElementById('btnClear').addEventListener('click', clearAll)
  document.getElementById('btnExport').addEventListener('click', exportPNG)
  document.getElementById('btnGridToggle').addEventListener('click', toggleGrid)
  document.getElementById('btnCopyLink').addEventListener('click', copyRoomLink)
  document.getElementById('btnTogglePanel').addEventListener('click', togglePanel)

  // 键盘快捷键
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
    switch (e.key.toLowerCase()) {
      case 'v': selectTool('select'); break
      case 'p': selectTool('pen'); break
      case 'r': selectTool('rect'); break
      case 'c': selectTool('circle'); break
      case 'l': selectTool('line'); break
      case 't': selectTool('text'); break
      case 'e': selectTool('eraser'); break
      case 'z': if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        if (e.shiftKey) redo(); else undo()
      } break
      case 'y': if (e.ctrlKey || e.metaKey) { e.preventDefault(); redo() } break
      case 'delete': deleteSelected(); break
      case 'g': if (e.ctrlKey || e.metaKey) { e.preventDefault(); toggleGrid() } break
    }
    if (e.key === ' ') { e.preventDefault(); STATE.isPanning = true; canvasWrap.classList.add('grabbing') }
  })
  document.addEventListener('keyup', e => {
    if (e.key === ' ') { STATE.isPanning = false; canvasWrap.classList.remove('grabbing') }
  })
}

function selectTool(tool) {
  if (activeTextInput && tool !== 'text') finishTextInput()
  STATE.tool = tool
  STATE.selectedObj = null
  document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool))
  if (tool === 'select') canvasWrap.style.cursor = 'default'
  else if (tool === 'text') canvasWrap.style.cursor = 'text'
  else if (tool === 'fill') canvasWrap.style.cursor = 'cell'
  else if (tool === 'eraser') canvasWrap.style.cursor = 'url(\'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="none" stroke="%23999" stroke-width="1.5"/></svg>\') 10 10, crosshair'
  else canvasWrap.style.cursor = getCrosshairCursor(STATE.color)
}

// ==================== 画布事件 ====================
function getCanvasPos(e) {
  const rect = mainCanvas.getBoundingClientRect()
  const x = (e.clientX - rect.left - STATE.offsetX) / STATE.scale
  const y = (e.clientY - rect.top - STATE.offsetY) / STATE.scale
  return { x, y }
}

// ==================== 文字内联输入 ====================
let activeTextInput = null

function finishTextInput() {
  if (!activeTextInput) return
  const value = activeTextInput.el.value.trim()
  if (value) {
    const obj = {
      id: genId(), tool: 'text',
      x: activeTextInput.worldX, y: activeTextInput.worldY,
      content: value.slice(0, 100),
      color: STATE.color, size: STATE.size,
      userId: STATE.userId, userColor: STATE.userColor
    }
    STATE.objects.push(obj)
    renderAll()
    send({ type: 'add', data: obj })
  }
  activeTextInput.el.remove()
  activeTextInput = null
}

function cancelTextInput() {
  if (!activeTextInput) return
  activeTextInput.el.remove()
  activeTextInput = null
}

function createTextInput(worldX, worldY, clientX, clientY) {
  if (activeTextInput) finishTextInput()
  const wrapRect = canvasWrap.getBoundingClientRect()
  const el = document.createElement('textarea')
  el.className = 'text-input-overlay'
  el.style.left = (clientX - wrapRect.left) + 'px'
  el.style.top = (clientY - wrapRect.top) + 'px'
  el.style.color = STATE.color
  el.style.fontSize = (STATE.size * 5) + 'px'
  el.style.lineHeight = (STATE.size * 5) + 'px'
  el.placeholder = '输入文字...'
  el.spellcheck = false
  el.rows = 1
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      finishTextInput()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      cancelTextInput()
    }
  })
  el.addEventListener('blur', () => finishTextInput())
  canvasWrap.appendChild(el)
  setTimeout(() => el.focus(), 0)
  activeTextInput = { el, worldX, worldY }
}

function getCanvasPixelPos(e) {
  const rect = mainCanvas.getBoundingClientRect()
  return {
    x: Math.round(e.clientX - rect.left),
    y: Math.round(e.clientY - rect.top)
  }
}

function setupCanvasEvents() {
  // 鼠标
  canvasWrap.addEventListener('mousedown', onPointerDown)
  canvasWrap.addEventListener('mousemove', onPointerMove)
  canvasWrap.addEventListener('mouseup', onPointerUp)
  canvasWrap.addEventListener('mouseleave', onPointerUp)
  canvasWrap.addEventListener('wheel', onWheel, { passive: false })

  // 触摸
  canvasWrap.addEventListener('touchstart', e => { e.preventDefault(); onPointerDown(e.touches[0]) }, { passive: false })
  canvasWrap.addEventListener('touchmove', e => { e.preventDefault(); onPointerMove(e.touches[0]) }, { passive: false })
  canvasWrap.addEventListener('touchend', e => { onPointerUp(e.changedTouches[0] || {}) })
}

function onPointerDown(e) {
  if (e.button !== undefined && e.button !== 0) return
  if (STATE.isPanning) { STATE.panStart = { x: e.clientX, y: e.clientY }; return }
  const pos = getCanvasPos(e)
  STATE.drawStart = pos

  const tool = STATE.tool

  if (tool === 'select') {
    STATE.selectedObj = hitTest(pos)
    if (STATE.selectedObj) {
      STATE.dragOffset = { x: pos.x - STATE.selectedObj.x, y: pos.y - STATE.selectedObj.y }
      STATE.isDragging = true
    } else {
      // 点击空白区域 → 进入平移模式
      STATE.isPanning = true
      STATE.panStart = { x: e.clientX, y: e.clientY }
      canvasWrap.classList.add('grabbing')
    }
    renderAll()
    return
  }

  if (tool === 'text') {
    e.preventDefault()
    createTextInput(pos.x, pos.y, e.clientX, e.clientY)
    return
  }

  if (tool === 'fill') {
    const pixelPos = getCanvasPixelPos(e)
    floodFill(pixelPos.x, pixelPos.y)
    return
  }

  if (tool === 'eraser') {
    STATE.isDrawing = true
    eraseAt(pos)
    return
  }

  STATE.isDrawing = true
  STATE.currentObj = {
    id: genId(), tool: tool, color: STATE.color, size: STATE.size,
    x: pos.x, y: pos.y, userId: STATE.userId, userColor: STATE.userColor,
    points: (tool === 'pen' || tool === 'marker' || tool === 'highlighter') ? [pos] : [],
  }
  if (tool === 'rect' || tool === 'circle' || tool === 'triangle') {
    STATE.currentObj.fill = e.shiftKey
  }
}

function onPointerMove(e) {
  // 平移
  if (STATE.isPanning && STATE.panStart) {
    STATE.offsetX += e.clientX - STATE.panStart.x
    STATE.offsetY += e.clientY - STATE.panStart.y
    STATE.panStart = { x: e.clientX, y: e.clientY }
    renderAll()
    return
  }

  const pos = getCanvasPos(e)

  // 远程光标（带上用户颜色，用于其他端显示）
  if (STATE.mode !== 'offline') {
    send({ type: 'cursor_move', x: Math.round(pos.x), y: Math.round(pos.y), color: STATE.userColor })
  }

  if (STATE.isDragging && STATE.selectedObj) {
    const newX = pos.x - STATE.dragOffset.x
    const newY = pos.y - STATE.dragOffset.y
    const dx = newX - STATE.selectedObj.x
    const dy = newY - STATE.selectedObj.y
    STATE.selectedObj.x = newX
    STATE.selectedObj.y = newY
    // 对于笔迹类对象，同步偏移所有 points
    if (STATE.selectedObj.points) {
      STATE.selectedObj.points = STATE.selectedObj.points.map(p => ({ x: p.x + dx, y: p.y + dy }))
    }
    renderAll()
    return
  }

  if (!STATE.isDrawing) return

  const tool = STATE.tool

  if (tool === 'eraser') {
    eraseAt(pos)
    return
  }

  const obj = STATE.currentObj
  if (tool === 'pen' || tool === 'marker' || tool === 'highlighter') {
    obj.points.push(pos)
    // 实时渲染到主画布
    STATE.objects.push({ ...obj, points: [...obj.points] })
    renderAll()
    STATE.objects.pop()
  } else if (tool === 'rect' || tool === 'circle' || tool === 'triangle') {
    obj.w = pos.x - obj.x
    obj.h = pos.y - obj.y
    STATE.objects.push({ ...obj })
    renderAll()
    STATE.objects.pop()
  } else if (tool === 'line' || tool === 'arrow') {
    obj.x2 = pos.x
    obj.y2 = pos.y
    STATE.objects.push({ ...obj })
    renderAll()
    STATE.objects.pop()
  }
}

function onPointerUp(e) {
  STATE.isPanning = false
  STATE.panStart = null

  if (STATE.isDragging) {
    STATE.isDragging = false
    if (STATE.selectedObj) {
      const changes = { x: STATE.selectedObj.x, y: STATE.selectedObj.y }
      // 笔迹类对象拖拽后同步发送偏移后的 points
      if (STATE.selectedObj.points) {
        changes.points = STATE.selectedObj.points.map(p => ({ x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 }))
      }
      send({ type: 'modify', id: STATE.selectedObj.id, changes })
      STATE._lastDrawTime = Date.now()
      STATE._pendingOps.push({ type: 'modify', id: STATE.selectedObj.id, changes, time: Date.now() })
    }
    return
  }

  if (!STATE.isDrawing) return
  STATE.isDrawing = false

  if (STATE.tool === 'eraser') {
    if (STATE.pendingEraseIds.size > 0) {
      // 收集被移除的对象，然后一次性过滤（避免在循环中反复遍历）
      const removed = []
      STATE.pendingEraseIds.forEach(id => {
        const obj = STATE.objects.find(o => o.id === id)
        if (obj) removed.push(obj)
      })
      STATE.objects = STATE.objects.filter(o => !STATE.pendingEraseIds.has(o.id))
      if (removed.length > 0) {
        for (const obj of removed) {
          STATE.history.push({ action: 'remove', object: obj })
          send({ type: 'remove', id: obj.id })
          STATE._lastDrawTime = Date.now()
          STATE._pendingOps.push({ type: 'remove', id: obj.id, time: Date.now() })
        }
        STATE.redoHistory = []
        if (STATE.history.length > STATE.maxHistory) STATE.history = STATE.history.slice(-STATE.maxHistory)
      }
      STATE.pendingEraseIds.clear()
      renderAll()
    }
    return
  }

  const obj = STATE.currentObj
  if (!obj) return

  // 检查是否为有效图形（最小尺寸）
  if ((obj.tool === 'rect' || obj.tool === 'circle' || obj.tool === 'triangle') && Math.abs(obj.w || 0) < 2 && Math.abs(obj.h || 0) < 2) return
  if ((obj.tool === 'pen' || obj.tool === 'marker' || obj.tool === 'highlighter') && obj.points.length < 2) return

  STATE.objects.push(obj)
  // history 中保存对象深拷贝，避免 points 数组引用被后续修改
  const historyObj = { ...obj }
  if (obj.points) historyObj.points = obj.points.map(p => ({ ...p }))
  STATE.history.push({ action: 'add', object: historyObj })
  STATE.redoHistory = [] // 新操作清空重做历史
  if (STATE.history.length > STATE.maxHistory) STATE.history.shift()
  STATE.currentObj = null
  renderAll()
  // 发送到服务端并加入待确认队列（用于丢包重发）
  send({ type: 'add', data: obj })
  STATE._lastDrawTime = Date.now()
  STATE._pendingOps.push({ type: 'add', id: obj.id, data: obj, time: Date.now() })
}

function onWheel(e) {
  e.preventDefault()
  const zoom = e.deltaY < 0 ? 1.1 : 0.9
  const newScale = Math.min(5, Math.max(0.1, STATE.scale * zoom))
  const rect = mainCanvas.getBoundingClientRect()
  const mx = e.clientX - rect.left, my = e.clientY - rect.top
  STATE.offsetX = mx - (mx - STATE.offsetX) * (newScale / STATE.scale)
  STATE.offsetY = my - (my - STATE.offsetY) * (newScale / STATE.scale)
  STATE.scale = newScale
  renderAll()
}

// ==================== 碰撞检测 ====================
function hitTest(pos) {
  for (let i = STATE.objects.length - 1; i >= 0; i--) {
    const o = STATE.objects[i]
    if (pointInObject(pos.x, pos.y, o)) return o
  }
  return null
}

function hitTestAll(x, y, radius) {
  const r2 = radius * radius
  return STATE.objects.filter(o => {
    if (o.tool === 'pen' || o.tool === 'marker' || o.tool === 'highlighter') {
      return (o.points || []).some(p => (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < r2)
    }
    if (o.tool === 'line' || o.tool === 'arrow') {
      return pointToSegmentDist(x, y, o.x || 0, o.y || 0, o.x2 || 0, o.y2 || 0) < radius
    }
    const bx = o.x || 0, by = o.y || 0, bw = o.w || 0, bh = o.h || 0
    const left = Math.min(bx, bx + bw), right = Math.max(bx, bx + bw)
    const top = Math.min(by, by + bh), bottom = Math.max(by, by + bh)
    const cx = Math.max(left, Math.min(x, right))
    const cy = Math.max(top, Math.min(y, bottom))
    return (cx - x) * (cx - x) + (cy - y) * (cy - y) < r2
  })
}

function pointInObject(x, y, obj) {
  const margin = 8
  switch (obj.tool) {
    case 'pen': case 'marker': case 'highlighter':
      return (obj.points || []).some(p => Math.abs(p.x - x) < margin && Math.abs(p.y - y) < margin)
    case 'rect': case 'triangle': case 'circle': {
      const left = Math.min(obj.x || 0, (obj.x || 0) + (obj.w || 0))
      const right = Math.max(obj.x || 0, (obj.x || 0) + (obj.w || 0))
      const top = Math.min(obj.y || 0, (obj.y || 0) + (obj.h || 0))
      const bottom = Math.max(obj.y || 0, (obj.y || 0) + (obj.h || 0))
      return x >= left - margin && x <= right + margin && y >= top - margin && y <= bottom + margin
    }
    case 'line': case 'arrow':
      return pointToSegmentDist(x, y, obj.x, obj.y, obj.x2, obj.y2) < margin
    case 'text':
      return x >= (obj.x || 0) && x <= (obj.x || 0) + 100 && y >= (obj.y || 0) && y <= (obj.y || 0) + 30
    default: return false
  }
}

function pointToSegmentDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

// ==================== 橡皮擦（像素级） ====================
function eraseAt(pos) {
  const hits = hitTestAll(pos.x, pos.y, STATE.size * 3)
  let changed = false
  for (const h of hits) {
    if (!STATE.pendingEraseIds.has(h.id)) {
      STATE.pendingEraseIds.add(h.id)
      changed = true
    }
  }
  if (changed) renderAll()
}

// ==================== 填充工具 ====================
function floodFill(sx, sy) {
  const canvas = mainCanvas
  const ctx = mainCtx
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const data = imageData.data
  const w = canvas.width, h = canvas.height

  const targetIdx = (sy * w + sx) * 4
  const targetR = data[targetIdx], targetG = data[targetIdx + 1], targetB = data[targetIdx + 2]

  const fillColor = hexToRgb(STATE.color)
  if (!fillColor) return

  // 如果颜色相同则跳过
  if (targetR === fillColor.r && targetG === fillColor.g && targetB === fillColor.b) return

  const stack = [[sx, sy]]
  const visited = new Set()
  const tolerance = 30
  const MAX_FILL_PIXELS = 500000

  function match(idx) {
    return Math.abs(data[idx] - targetR) <= tolerance &&
           Math.abs(data[idx + 1] - targetG) <= tolerance &&
           Math.abs(data[idx + 2] - targetB) <= tolerance
  }

  let filledCount = 0
  while (stack.length > 0 && filledCount < MAX_FILL_PIXELS) {
    const [x, y] = stack.pop()
    const key = x + ',' + y
    if (visited.has(key)) continue
    if (x < 0 || x >= w || y < 0 || y >= h) continue
    const idx = (y * w + x) * 4
    if (!match(idx)) continue
  visited.add(key)
  data[idx] = fillColor.r; data[idx + 1] = fillColor.g; data[idx + 2] = fillColor.b
  data[idx + 3] = 255
  filledCount++
  stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
  }

  ctx.putImageData(imageData, 0, 0)

  // 将填充结果保存为 dataURL，确保重绘时能恢复
  // 使用临时画布仅裁剪填充区域，减少 dataURL 体积
  const tempCanvasForFill = document.createElement('canvas')
  const tempCtxForFill = tempCanvasForFill.getContext('2d')

  // 计算填充区域的边界框，减少 dataURL 体积
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (const key of visited) {
    const [vx, vy] = key.split(',').map(Number)
    if (vx < minX) minX = vx
    if (vy < minY) minY = vy
    if (vx > maxX) maxX = vx
    if (vy > maxY) maxY = vy
  }

  // 加一点边距
  const pad = 2
  minX = Math.max(0, minX - pad)
  minY = Math.max(0, minY - pad)
  maxX = Math.min(w - 1, maxX + pad)
  maxY = Math.min(h - 1, maxY + pad)

  const cropW = maxX - minX + 1
  const cropH = maxY - minY + 1
  tempCanvasForFill.width = cropW
  tempCanvasForFill.height = cropH
  tempCtxForFill.putImageData(
    ctx.getImageData(minX, minY, cropW, cropH), 0, 0
  )

  const dataUrl = tempCanvasForFill.toDataURL('image/png')

  // 注意：填充在画布像素空间操作，但存储坐标需转换为世界坐标，
  // 否则在缩放/平移后重新渲染时位置会偏移
  const worldMinX = (minX - STATE.offsetX) / STATE.scale
  const worldMinY = (minY - STATE.offsetY) / STATE.scale
  const worldCropW = cropW / STATE.scale
  const worldCropH = cropH / STATE.scale

  const obj = {
    id: genId(),
    tool: 'fill',
    x: worldMinX,
    y: worldMinY,
    w: worldCropW,
    h: worldCropH,
    dataUrl: dataUrl,
    color: STATE.color,
    size: 1,
    userId: STATE.userId,
    userColor: STATE.userColor,
  }
  STATE.objects.push(obj)
  STATE.history.push({ action: 'add', object: { ...obj } })
  STATE.redoHistory = []
  renderAll()
  send({ type: 'add', data: obj })
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
  return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : null
}

// ==================== 操作 ====================
function undo() {
  if (STATE.history.length === 0) return
  const last = STATE.history.pop()
  if (last.action === 'add' && last.object) {
    STATE.redoHistory.push({ action: 'add', object: last.object })
    STATE.objects = STATE.objects.filter(o => o.id !== last.object.id)
  } else if (last.action === 'remove' && last.object) {
    STATE.redoHistory.push({ action: 'remove', object: last.object })
    STATE.objects.push(last.object)
  } else if (last.action === 'clear' && last.oldObjects) {
    STATE.redoHistory.push({ action: 'clear', oldObjects: last.oldObjects })
    STATE.objects = last.oldObjects
  }
  renderAll()
  send({ type: 'undo' })
}

function redo() {
  if (STATE.redoHistory.length === 0) return
  const item = STATE.redoHistory.pop()
  if (item.action === 'add' && item.object) {
    STATE.objects.push(item.object)
    STATE.history.push({ action: 'add', object: item.object })
    // 同步到其他用户
    send({ type: 'add', data: item.object })
  } else if (item.action === 'remove' && item.object) {
    STATE.objects = STATE.objects.filter(o => o.id !== item.object.id)
    STATE.history.push({ action: 'remove', object: item.object })
    send({ type: 'remove', id: item.object.id })
  } else if (item.action === 'clear' && item.oldObjects) {
    STATE.history.push({ action: 'clear', oldObjects: [...STATE.objects] })
    STATE.objects = []
    send({ type: 'clear' })
    STATE._lastDrawTime = Date.now()
    STATE._pendingOps.push({ type: 'clear', id: 'clear_' + Date.now(), time: Date.now() })
  }
  renderAll()
}

function toggleGrid() {
  STATE.showGrid = !STATE.showGrid
  renderAll()
  const btn = document.getElementById('btnGridToggle')
  btn.style.opacity = STATE.showGrid ? '1' : '0.5'
  toast(STATE.showGrid ? '📐 网格已显示' : '📐 网格已隐藏')
}

function copyRoomLink() {
  const url = window.location.origin + '/whiteboard?room=' + STATE.roomKey
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => toast('✅ 房间链接已复制！\n' + url))
  } else {
    const ta = document.createElement('textarea')
    ta.value = url; document.body.appendChild(ta)
    ta.select(); document.execCommand('copy'); document.body.removeChild(ta)
    toast('✅ 房间链接已复制！')
  }
}

function clearAll() {
  if (!confirm('确定清空画板？此操作可撤销。')) return
  STATE.history.push({ action: 'clear', oldObjects: [...STATE.objects] })
  STATE.redoHistory = []
  STATE.objects = []
  renderAll()
  send({ type: 'clear' })
}

function deleteSelected() {
  if (!STATE.selectedObj) return
  STATE.objects = STATE.objects.filter(o => o.id !== STATE.selectedObj.id)
  STATE.redoHistory = []
  send({ type: 'remove', id: STATE.selectedObj.id })
  STATE.selectedObj = null
  renderAll()
}

function exportPNG() {
  const canvas = document.createElement('canvas')
  canvas.width = mainCanvas.width * 2
  canvas.height = mainCanvas.height * 2
  const ctx = canvas.getContext('2d')
  ctx.scale(2, 2)
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, mainCanvas.width, mainCanvas.height)
  // 应用与显示画面一致的画布变换
  ctx.translate(STATE.offsetX, STATE.offsetY)
  ctx.scale(STATE.scale, STATE.scale)
  // 重绘所有对象
  for (const obj of STATE.objects) {
    drawObject(ctx, obj)
  }
  const a = document.createElement('a')
  a.download = `whiteboard_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`
  a.href = canvas.toDataURL('image/png')
  a.click()
  toast('✅ 已导出 PNG')
}

// ==================== 聊天 ====================
function sendChat() {
  const input = document.getElementById('chatInput')
  if (!input) { console.error('[sendChat] chatInput element not found'); return }
  const content = input.value.trim()
  console.log('[sendChat] content:', content, 'mode:', STATE.mode, 'wsReady:', STATE.ws ? STATE.ws.readyState : 'no ws')
  if (!content) { console.log('[sendChat] empty content, skip'); return }
  input.value = ''
  const msg = { type: 'chat', content }
  send(msg)
  // 无论 ws/local/offline，只要消息成功构造就本地显示（避免 ws 断开但 mode 仍为 'ws' 时消息丢失）
  addChatMessage({ nickname: STATE.nickname, color: STATE.userColor, content, timestamp: new Date().toISOString() })
}

function addChatMessage(msg) {
  const div = document.getElementById('chatMessages')
  if (!div) { console.error('[addChatMessage] chatMessages element not found'); return }
  const el = document.createElement('div')
  el.className = 'chat-msg'
  el.dataset.msgId = msg.id || ''
  const time = msg.timestamp ? new Date(msg.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''
  const isOwn = msg.id && STATE.userId && msg.userId === STATE.userId
  const isOwner = STATE.ownerKey && STATE.wsKey === STATE.ownerKey
  const canDelete = isOwn || (isOwner && msg.id)  // 发送者本人或房主可删
  el.innerHTML = `<span class="chat-name" style="color:${msg.color || '#999'}">${xss(msg.nickname || '匿名')}:</span>${xss(msg.content)}<span class="chat-time">${time}</span>${canDelete ? `<button class="chat-del-btn" onclick="deleteChatMessage(${msg.id})" title="删除">✕</button>` : ''}`
  div.appendChild(el)
  div.scrollTop = div.scrollHeight
}

function deleteChatMessage(id) {
  if (!confirm('确定删除此消息？')) return
  send({ type: 'delete_chat', id })
}

function removeChatMessage(id) {
  const el = document.querySelector(`.chat-msg[data-msg-id="${id}"]`)
  if (el) el.remove()
}

// ==================== 存档 ====================
function saveState() {
  const name = document.getElementById('saveName').value.trim() || ('存档 ' + new Date().toLocaleTimeString())
  send({ type: 'save_state', name })
  document.getElementById('saveName').value = ''
}

function loadState(id) {
  if (!confirm('加载存档将替换当前画板，确定？')) return
  send({ type: 'load_state', state_id: id })
}

function deleteState(id) {
  if (!confirm('确定删除此存档？')) return
  send({ type: 'delete_state', state_id: id })
}

function refreshStates() {
  send({ type: 'list_states' })
}

function renderStatesList(states) {
  const div = document.getElementById('statesList')
  if (!states || states.length === 0) {
    div.innerHTML = '<div style="color:#999;font-size:12px;text-align:center;padding:20px 0;">暂无存档</div>'
    return
  }
  const isLocalMode = STATE.mode !== 'ws'
  const deleteFn = isLocalMode ? 'deleteLocalState' : 'deleteState'
  div.innerHTML = states.map(s => `
    <div class="state-item" data-state-id="${s.id}" data-has-preview="${s.has_preview ? 1 : 0}">
      <span>📄 ${xss(s.name)}<br><small style="color:#999">${new Date(s.created_at).toLocaleString('zh-CN')}${isLocalMode ? ' [本地]' : ''}</small></span>
      <div style="display:flex;gap:4px;">
        <button class="load-btn" onclick="loadState(${s.id})">加载</button>
        <button class="load-btn" onclick="${deleteFn}(${s.id})">删除</button>
      </div>
    </div>
  `).join('')

  // 为每个存档项绑定悬停预览事件
  div.querySelectorAll('.state-item').forEach(el => {
    let previewTimer = null
    let previewEl = null

    el.addEventListener('mouseenter', () => {
      previewTimer = setTimeout(() => {
        const stateId = el.dataset.stateId
        showStatePreview(stateId, el)
      }, 500) // 悬停 500ms 后显示预览
    })

    el.addEventListener('mouseleave', () => {
      if (previewTimer) { clearTimeout(previewTimer); previewTimer = null }
      hideStatePreview()
    })
  })
}

// ==================== 存档预览 ====================
let _previewCanvas = null
let _previewPopup = null

function showStatePreview(stateId, refEl) {
  if (STATE.mode !== 'ws') {
    console.log('[预览] 跳过: 非在线模式')
    return
  }
  console.log('[预览] 请求预览, stateId:', stateId)

  // 创建或获取预览弹出层
  if (!_previewPopup) {
    _previewPopup = document.createElement('div')
    _previewPopup.className = 'state-preview-popup'
    _previewPopup.innerHTML = '<div class="state-preview-loading">加载预览...</div>'
    document.body.appendChild(_previewPopup)
  }

  // 创建预览 Canvas
  if (!_previewCanvas) {
    _previewCanvas = document.createElement('canvas')
    _previewCanvas.width = 200
    _previewCanvas.height = 140
    _previewCanvas.style.width = '200px'
    _previewCanvas.style.height = '140px'
    _previewCanvas.style.borderRadius = '4px'
  }

  // 定位弹出层
  const rect = refEl.getBoundingClientRect()
  _previewPopup.innerHTML = ''
  _previewPopup.appendChild(_previewCanvas)
  _previewPopup.style.display = 'block'
  _previewPopup.style.left = Math.max(10, rect.left - 210) + 'px'  // 在左侧显示
  _previewPopup.style.top = Math.max(10, rect.top) + 'px'

  // 显示加载中
  const ctx = _previewCanvas.getContext('2d')
  ctx.clearRect(0, 0, 200, 140)
  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, 200, 140)
  ctx.fillStyle = '#999'
  ctx.font = '12px sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('加载中...', 100, 70)

  // 发送请求获取存档数据
  send({ type: 'preview_state', state_id: stateId })
}

function hideStatePreview() {
  if (_previewPopup) {
    _previewPopup.style.display = 'none'
  }
}

// 处理后端返回的预览数据
function renderStatePreview(stateId, objects) {
  console.log('[预览渲染] stateId:', stateId, 'objects len:', objects && objects.length, 'popup:', _previewPopup && _previewPopup.style.display)
  if (!_previewCanvas || !_previewPopup || _previewPopup.style.display === 'none') {
    console.log('[预览渲染] 跳过: canvas或popup不可用')
    return
  }

  const ctx = _previewCanvas.getContext('2d')
  const w = 200, h = 140

  // 清空并绘制背景
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = '#f8f9fa'
  ctx.fillRect(0, 0, w, h)

  if (!objects || objects.length === 0) {
    ctx.fillStyle = '#999'
    ctx.font = '12px sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('空画板', 100, 70)
    return
  }

  // 计算所有对象的包围盒，确定缩放比例
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  let totalPoints = 0
  objects.forEach(obj => {
    const toolType = obj.tool || obj.type || ''
    if (toolType === 'pen' || toolType === 'marker' || toolType === 'highlighter') {
      const pts = obj.points || []
      totalPoints += pts.length
      pts.forEach(p => {
        if (p.x < minX) minX = p.x
        if (p.y < minY) minY = p.y
        if (p.x > maxX) maxX = p.x
        if (p.y > maxY) maxY = p.y
      })
    } else if (toolType === 'text') {
      const tx = obj.x || 0, ty = obj.y || 0
      const txtW = (obj.content || '').length * (obj.size || 3) * 5 + 10
      const txtH = (obj.size || 3) * 5 + 10
      if (tx < minX) minX = tx
      if (ty < minY) minY = ty
      if (tx + txtW > maxX) maxX = tx + txtW
      if (ty + txtH > maxY) maxY = ty + txtH
    } else if (toolType === 'line' || toolType === 'arrow') {
      if (obj.x < minX) minX = obj.x
      if (obj.y < minY) minY = obj.y
      if (obj.x2 > maxX) maxX = obj.x2
      if (obj.y2 > maxY) maxY = obj.y2
    } else {
      const ox = obj.x || 0, oy = obj.y || 0
      const ow = obj.w || 40, oh = obj.h || 40
      if (ox < minX) minX = ox
      if (oy < minY) minY = oy
      if (ox + ow > maxX) maxX = ox + ow
      if (oy + oh > maxY) maxY = oy + oh
    }
  })

  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 800; maxY = 600 }

  // 日志：记录边界和尺寸
  console.log('[预览] 边界:', {minX, minY, maxX, maxY}, '工具类型:', objects.map(o => o.tool || o.type || '?').join(','), '总点数:', totalPoints)
  if (objects.length > 0) console.log('[预览] 第一个对象:', JSON.stringify(objects[0]).slice(0, 200))

  // 计算缩放
  const pad = 20
  const contentW = maxX - minX + pad * 2
  const contentH = maxY - minY + pad * 2
  const scale = Math.min(w / contentW, h / contentH, 1)
  const offsetX = (w - contentW * scale) / 2
  const offsetY = (h - contentH * scale) / 2
  console.log('[预览] 缩放:', {scale, offsetX, offsetY, contentW, contentH})

  ctx.save()
  ctx.translate(offsetX, offsetY)
  ctx.scale(scale, scale)
  ctx.translate(-minX + pad, -minY + pad)

  // 绘制每个对象（使用最小线宽确保缩放后可见）
  const minLineWidth = Math.max(3 / scale, 1) // 缩放后至少 3 像素的线宽

  // 绘制每个对象
  objects.forEach(obj => {
    const color = obj.color || obj.userColor || '#333'
    const size = obj.size || 2
    const toolType = obj.tool || obj.type || ''
    ctx.strokeStyle = color
    ctx.fillStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    // 使用最小线宽确保缩放后可见（至少 3 像素屏幕空间）
    ctx.lineWidth = Math.max(size, minLineWidth)

    if (toolType === 'pen' || toolType === 'marker' || toolType === 'highlighter') {
      const pts = obj.points || []
      if (pts.length < 2) return
      ctx.globalAlpha = (toolType === 'marker') ? 0.7 : (toolType === 'highlighter') ? 0.25 : 1
      ctx.beginPath()
      ctx.moveTo(pts[0].x, pts[0].y)
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i].x, pts[i].y)
      }
      ctx.stroke()
      ctx.globalAlpha = 1
    } else if (toolType === 'rect') {
      const rw = obj.w || 0, rh = obj.h || 0
      if (obj.fill) {
        ctx.globalAlpha = 0.3
        ctx.fillRect(obj.x, obj.y, rw, rh)
        ctx.globalAlpha = 1
      }
      ctx.strokeRect(obj.x, obj.y, rw, rh)
    } else if (toolType === 'circle') {
      const rx = (obj.w || 0) / 2, ry = (obj.h || 0) / 2
      const cx = obj.x + rx, cy = obj.y + ry
      const r = Math.min(Math.abs(rx), Math.abs(ry)) || 1
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      if (obj.fill) {
        ctx.globalAlpha = 0.3
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.stroke()
    } else if (toolType === 'line') {
      ctx.beginPath()
      ctx.moveTo(obj.x, obj.y)
      ctx.lineTo(obj.x2, obj.y2)
      ctx.stroke()
    } else if (toolType === 'arrow') {
      const ax = obj.x, ay = obj.y, ax2 = obj.x2, ay2 = obj.y2
      const angle = Math.atan2(ay2 - ay, ax2 - ax)
      ctx.beginPath()
      ctx.moveTo(ax, ay)
      ctx.lineTo(ax2, ay2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(ax2, ay2)
      ctx.lineTo(ax2 - 10 * Math.cos(angle - 0.4), ay2 - 10 * Math.sin(angle - 0.4))
      ctx.lineTo(ax2 - 10 * Math.cos(angle + 0.4), ay2 - 10 * Math.sin(angle + 0.4))
      ctx.closePath()
      ctx.fill()
    } else if (toolType === 'triangle') {
      ctx.beginPath()
      ctx.moveTo(obj.x + (obj.w || 0) / 2, obj.y)
      ctx.lineTo(obj.x + (obj.w || 0), obj.y + (obj.h || 0))
      ctx.lineTo(obj.x, obj.y + (obj.h || 0))
      ctx.closePath()
      if (obj.fill) {
        ctx.globalAlpha = 0.3
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.stroke()
    } else if (toolType === 'text') {
      const fontSize = (obj.size || 3) * 5
      ctx.font = `${fontSize}px 'Microsoft YaHei', sans-serif`
      ctx.textBaseline = 'top'
      ctx.fillText(obj.content || '', obj.x || 0, obj.y || 0)
    }
  })

  ctx.restore()
}

// ==================== 侧面板 ====================
function setupSidePanel() {
  document.querySelectorAll('.side-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.side-tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.side-content').forEach(c => c.classList.remove('active'))
      tab.classList.add('active')
      document.getElementById('panel-' + tab.dataset.panel).classList.add('active')
      if (tab.dataset.panel === 'saves') refreshStates()
    })
  })
}

function togglePanel() {
  document.getElementById('sidePanel').classList.toggle('collapsed')
}

function exitRoom() {
  if (!confirm('确定退出房间？')) return
  // 关闭定时器
  if (STATE._syncTimer) { clearTimeout(STATE._syncTimer); STATE._syncTimer = null }
  if (STATE._pendingRetryTimer) { clearInterval(STATE._pendingRetryTimer); STATE._pendingRetryTimer = null }
  STATE._lastDrawTime = 0
  // 关闭 WebSocket 连接（如果有）
  if (STATE.ws) {
    try { STATE.ws.close() } catch (e) {}
    STATE.ws = null
  }
  // 清理画板状态
  STATE.objects = []
  STATE.history = []
  STATE.redoHistory = []
  STATE.mode = 'local'
  STATE.users = {}
  STATE.roomPassword = ''
  STATE.roomKey = ''
  STATE._pendingOps = []
  // 清除 localStorage 中的房间缓存（下次刷新不再自动重连）
  localStorage.removeItem('wb_room_key')
  localStorage.removeItem('wb_room_password')
  // 返回房间选择对话框
  renderAll()
  showRoomDialog()
}

function logout() {
  if (!confirm('确定退出登录？')) return
  if (STATE._syncTimer) { clearTimeout(STATE._syncTimer); STATE._syncTimer = null }
  if (STATE._pendingRetryTimer) { clearInterval(STATE._pendingRetryTimer); STATE._pendingRetryTimer = null }
  STATE._lastDrawTime = 0
  localStorage.removeItem('wb_token')
  localStorage.removeItem('wb_user')
  localStorage.removeItem('wb_room_key')
  localStorage.removeItem('wb_room_password')
  STATE.token = ''
  STATE._pendingOps = []
  // 关闭 WS 并跳转到登录页
  if (STATE.ws) {
    try { STATE.ws.close() } catch (e) {}
    STATE.ws = null
  }
  window.location.href = '/'
}

function updateUserList() {
  const div = document.getElementById('panel-users')
  const users = Object.entries(STATE.users)
  if (users.length === 0) {
    div.innerHTML = '<div style="color:#999;font-size:12px;text-align:center;padding:20px 0;">等待其他用户加入...</div>'
    return
  }
  const isOwner = STATE.ownerKey && STATE.wsKey === STATE.ownerKey
  div.innerHTML = users.map(([id, u]) => {
    const isMe = u.wsKey === STATE.wsKey || id === STATE.wsKey
    const isUserOwner = u.wsKey === STATE.ownerKey || id === STATE.ownerKey
    return `
    <div class="user-item${isMe ? ' user-me' : ''}">
      <div class="user-dot" style="background:${u.color || '#999'}"></div>
      <span>${isUserOwner ? '👑 ' : ''}${xss(u.nickname || '匿名')}${isMe ? ' (我)' : ''}</span>
      ${isOwner && !isMe ? `<button class="kick-btn" onclick="kickUser('${u.wsKey || id}')">踢出</button>` : ''}
    </div>`
  }).join('')
}

function kickUser(targetWsKey) {
  if (!confirm('确定将该用户踢出房间？')) return
  send({ type: 'kick', targetWsKey })
}

function updateOnlineCount() {
  const count = Object.keys(STATE.users).length
  // 更新底部状态栏的在线人数
  const bar = document.getElementById('onlineCountBar')
  if (bar) bar.textContent = `👥 ${count} 人在线`
  // 更新面板底部用户信息
  const panelInfo = document.getElementById('panelUserInfo')
  if (panelInfo) panelInfo.textContent = STATE.nickname ? '用户: ' + STATE.nickname : ''
}

function updateStatus(status) {
  const dot = document.getElementById('statusDot')
  const badge = document.getElementById('modeBadge')
  dot.className = 'status-dot'
  if (status === 'online') {
    dot.classList.add('online'); badge.className = 'online'; badge.textContent = '在线模式'
  } else if (status === 'local') {
    dot.classList.add('local'); badge.className = 'local'; badge.textContent = '本机模式'
  } else if (status === 'connecting') {
    dot.classList.add('local'); badge.className = 'local'; badge.textContent = '连接中...'
  } else {
    dot.classList.add('offline'); badge.className = 'offline'; badge.textContent = '离线'
  }
  document.getElementById('roomInfo').textContent = STATE.roomKey ? `房间: ${STATE.roomKey}` : '请选择房间'
  document.getElementById('userInfo').textContent = STATE.nickname
}

// ==================== 工具函数 ====================
function genId() { return 'obj_' + Math.random().toString(36).slice(2, 10) }
function xss(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

function toast(msg) {
  const el = document.createElement('div')
  el.className = 'toast'
  el.style.whiteSpace = 'pre-line'
  el.textContent = msg
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 3000)
}

// ==================== 暴露到全局 ====================
window.joinRoom = joinRoom
window.generateRoom = generateRoom
window.sendChat = sendChat
window.saveState = saveState
window.loadState = loadState
window.deleteState = deleteState
window.deleteLocalState = deleteLocalState
window.deleteChatMessage = deleteChatMessage
window.kickUser = kickUser
window.exitRoom = exitRoom
window.togglePanel = togglePanel
window.logout = logout

// ==================== 启动 ====================
init()
// 定时刷新远程光标
setInterval(renderRemoteCursors, 200)
// 定时刷新存档列表
setTimeout(refreshStates, 1000)
