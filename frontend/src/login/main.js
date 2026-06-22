import './style.css'

let currentTab = 'login'
const API = window.location.origin

function switchTab(tab) {
  currentTab = tab
  document.querySelectorAll('.tab').forEach((t, i) => t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register')))
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none'
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none'
  document.getElementById('errorMsg').textContent = ''
  document.getElementById('successMsg').textContent = ''
}

async function doLogin() {
  const u = document.getElementById('loginUser').value.trim()
  const p = document.getElementById('loginPass').value.trim()
  const e = document.getElementById('errorMsg')
  e.textContent = ''
  if (!u || !p) { e.textContent = '请填写用户名和密码'; return }
  try {
    const r = await fetch(API + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    })
    const d = await r.json()
    if (!r.ok) { e.textContent = d.detail || '登录失败'; return }
    localStorage.setItem('wb_token', d.token)
    localStorage.setItem('wb_user', JSON.stringify(d.user))
    goToWhiteboard()
  } catch (ex) { e.textContent = '服务器连接失败，请确认服务器已启动' }
}

async function doRegister() {
  const u = document.getElementById('regUser').value.trim()
  const n = document.getElementById('regNick').value.trim()
  const p = document.getElementById('regPass').value.trim()
  const e = document.getElementById('errorMsg')
  const s = document.getElementById('successMsg')
  e.textContent = ''; s.textContent = ''
  if (u.length < 2) { e.textContent = '用户名至少2个字符'; return }
  if (p.length < 4) { e.textContent = '密码至少4位'; return }
  try {
    const r = await fetch(API + '/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p, nickname: n || u })
    })
    const d = await r.json()
    if (!r.ok) { e.textContent = d.detail || '注册失败'; return }
    localStorage.setItem('wb_token', d.token)
    localStorage.setItem('wb_user', JSON.stringify(d.user))
    s.textContent = '注册成功！即将跳转...'
    setTimeout(goToWhiteboard, 800)
  } catch (ex) { e.textContent = '服务器连接失败，请确认服务器已启动' }
}

function enterAsGuest() {
  localStorage.removeItem('wb_token')
  localStorage.removeItem('wb_user')
  goToWhiteboard()
}

function goToWhiteboard() {
  const room = document.getElementById('roomKey').value.trim()
  const pwd = document.getElementById('roomPwd').value.trim()
  let url = API + '/whiteboard'
  const params = []
  if (room) params.push('room=' + encodeURIComponent(room))
  if (pwd) params.push('password=' + encodeURIComponent(pwd))
  if (params.length > 0) url += '?' + params.join('&')
  window.location.href = url
}

// 回车快捷提交
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (currentTab === 'login') doLogin()
    else doRegister()
  }
})

// 暴露到全局作用域，供 HTML onclick 调用
window.switchTab = switchTab
window.doLogin = doLogin
window.doRegister = doRegister
window.enterAsGuest = enterAsGuest
