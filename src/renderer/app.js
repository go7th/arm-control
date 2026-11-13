/**
 * 界面只有四件事：按住说话 / 操作说明 / 选择硬件 / 连接状态
 * 急停不设按钮：Esc 键 + 语音热词「急停」（主进程旁路，永不经网络）
 */
import { startRecording, stopRecording } from './recorder.js'
import * as serial from './serial.js'

const $ = (id) => document.getElementById(id)

const STATE_LABEL = {
  idle: '空闲',
  listening: '聆听中',
  recording: '录音中',
  processing: '解析中',
  speaking: '播报中'
}

let sessionMode = null
let pttHeld = false
let recordingOpen = false

// ---------- 状态读数（只读仪表）----------
function setState(state) {
  const el = $('st-state')
  el.textContent = STATE_LABEL[state] || state
  el.className = `cell-val ${state}`
}

function flashError(text) {
  const el = $('st-state')
  el.textContent = text
  el.className = 'cell-val err'
  setTimeout(() => {
    if (el.classList.contains('err')) setState(sessionMode ? 'listening' : 'idle')
  }, 2600)
}

function onLog(entry) {
  if (entry.kind === 'asr') {
    $('st-heard').textContent = entry.text
    return
  }
  if (entry.kind === 'tx' || entry.kind === 'rx') {
    $('st-tx').textContent = entry.text
    return
  }
  if (entry.kind === 'err') {
    flashError(entry.text)
    return
  }
  // info / rule / llm：状态栏提示（规则命中、云端解析中…）
  if (entry.text && entry.kind !== 'info') $('st-state').textContent = entry.text
}

window.api.onStateChange(setState)
window.api.onLog(onLog)
window.api.onSerialWrite((str) => serial.write(str, onLog))

// ---------- TTS 播报 ----------
let playCtx = null
window.api.onPlayAudio(({ samples, sampleRate }) => {
  playCtx = playCtx || new AudioContext()
  const buf = playCtx.createBuffer(1, samples.length, sampleRate)
  buf.copyToChannel(new Float32Array(samples), 0)
  const src = playCtx.createBufferSource()
  src.buffer = buf
  src.connect(playCtx.destination)
  src.onended = () => window.api.playbackEnded()
  src.start()
})

// ---------- 选择硬件 + 连接状态 ----------
function renderConn() {
  const on = serial.isConnected()
  $('conn').classList.toggle('on', on)
  $('conn-label').textContent = on ? '已连接' : '未连接'
  $('conn-detail').textContent = on ? 'USART1 · 115200 8N1' : '等待选择硬件'
  $('btn-serial').textContent = on ? '断开连接' : '选择硬件'
}

$('btn-serial').addEventListener('click', async () => {
  if (serial.isConnected()) {
    await serial.disconnect(onLog)
    renderConn()
    return
  }
  const baud = (await window.api.getConfig()).serialBaud || 115200
  const r = await serial.connect(baud, onLog)
  if (r.ok) renderConn()
  else flashError(`连接失败: ${r.error}`)
})

// ---------- 急停（Esc / 语音热词）----------
async function estop() {
  if (serial.isConnected()) await serial.write('$DST!', onLog) // 本地直发，不等主进程
  window.api.estop()
}

// ---------- 按住说话 ----------
async function ensureSession() {
  if (sessionMode === 'ptt') return true
  const r = await window.api.startSession('ptt')
  if (!r.ok) {
    flashError(`语音引擎启动失败: ${r.error}`)
    return false
  }
  sessionMode = 'ptt'
  return true
}

async function pttDown() {
  if (pttHeld) return
  pttHeld = true
  $('ptt-wrap').classList.add('armed')
  if (!(await ensureSession())) {
    pttHeld = false
    $('ptt-wrap').classList.remove('armed')
    return
  }
  if (!pttHeld) return // 等待引擎加载期间已松开
  await startRecording((float32) => window.api.sendAudio(float32))
  recordingOpen = true
}

async function pttUp() {
  if (!pttHeld) return
  pttHeld = false
  $('ptt-wrap').classList.remove('armed')
  if (!recordingOpen) return
  recordingOpen = false
  stopRecording() // 先关麦克风，避免环境音混进下一句
  await window.api.stopRecording() // 主进程拼接整段识别
}

const pttBtn = $('btn-ptt')
pttBtn.addEventListener('mousedown', pttDown)
pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); pttDown() }, { passive: false })
window.addEventListener('mouseup', pttUp)
window.addEventListener('touchend', (e) => { e.preventDefault(); pttUp() }, { passive: false })

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && e.target === document.body) {
    e.preventDefault()
    pttDown()
  }
  if (e.code === 'Escape') {
    pttUp()
    estop()
  }
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    e.preventDefault()
    pttUp()
  }
})

renderConn()
