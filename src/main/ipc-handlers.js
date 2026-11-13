/**
 * 主进程编排：麦克风音频 → VAD → 离线ASR → 指令（急停旁路/快速规则/云LLM）→ 串口
 *
 * 串口本体在渲染进程（Web Serial），主进程把串口字符串推给渲染进程写出去：
 *   mainWindow.webContents.send('serial:write', '$DGS:3!')
 */
import { ipcMain } from 'electron'
import { initAll, initTTS, destroyAll, feedAudioToVAD, synthesize, flushVAD } from './audio-engine.js'
import { recognize } from './asr.js'
import { getConfig, saveConfig, loadConfig } from './config.js'
import { matchStop, matchQuickCommand, toolCallToCommand, toSerial, describe } from './commands.js'
import { parseIntent } from './llm.js'

let currentState = 'idle'
let sessionMode = null // 'auto' (VAD 免按键) | 'ptt' (按住说话)
let mainWindow = null
let audioBuffer = [] // 按住说话时收集音频块
let busy = false // 一条指令处理中（LLM 路径），期间新句子先排队丢弃

export function setMainWindow(win) {
  mainWindow = win
}

function setState(state) {
  currentState = state
  mainWindow?.webContents.send('state:change', state)
}

function log(entry) {
  // entry: { kind: 'asr'|'rule'|'llm'|'tx'|'err'|'info', text }
  mainWindow?.webContents.send('log', { ...entry, time: Date.now() })
}

function sendSerial(serialStr, label) {
  if (!serialStr) return
  log({ kind: 'tx', text: `${serialStr}   ← ${label}` })
  mainWindow?.webContents.send('serial:write', serialStr)
}

function speak(text) {
  if (!text || !getConfig().ttsEnabled) return
  try {
    initTTS(getConfig().ttsVoice) // 幂等；会话未启动（如直接按急停）时懒加载
    setState('speaking')
    const audio = synthesize(text)
    mainWindow?.webContents.send('audio:play', {
      samples: Array.from(audio.samples),
      sampleRate: audio.sampleRate
    })
  } catch (e) {
    console.error('TTS error:', e)
    setState(sessionMode === 'auto' ? 'listening' : 'idle')
  }
}

// 急停：所有路径共用（语音热词 / UI 按钮 / LLM stop 工具）
function emergencyStop(source = '急停') {
  sendSerial('$DST!', source)
  speak('已停止')
}

/**
 * 一句话的完整处理链：急停旁路 → 快速规则 → 云 LLM
 */
async function handleText(rawText) {
  try {
    await handleTextInner(rawText)
  } finally {
    // 播报中由 playback-ended 复位；其余情况这里兜底
    if (currentState !== 'speaking') {
      setState(sessionMode === 'auto' ? 'listening' : 'idle')
    }
  }
}

async function handleTextInner(rawText) {
  const text = rawText.trim()
  if (!text) return
  log({ kind: 'asr', text })

  // 1. 急停热词：永不过 LLM，立刻执行
  if (matchStop(text)) {
    emergencyStop('语音急停')
    return
  }

  // 2. 快速规则：固定口令直接映射
  const quick = matchQuickCommand(text)
  if (quick) {
    log({ kind: 'rule', text: `规则命中: ${quick.label}` })
    sendSerial(toSerial(quick.command), quick.label)
    speak(quick.speak)
    return
  }

  // 3. 云 LLM：口语化/复杂指令
  if (busy) {
    log({ kind: 'info', text: '上一条指令还在处理，已忽略' })
    return
  }
  busy = true
  setState('processing')
  log({ kind: 'llm', text: '云端解析中…' })
  try {
    const result = await parseIntent(text)
    if (result.error) {
      log({ kind: 'err', text: result.error })
      speak('指令解析失败')
      return
    }
    if (result.tool) {
      const checked = toolCallToCommand(result.tool.name, result.tool.args)
      if (!checked.ok) {
        log({ kind: 'err', text: `拒绝执行: ${checked.error}` })
        speak('参数超范围，已拒绝')
        return
      }
      log({ kind: 'llm', text: `LLM → ${describe(checked.command)}` })
      sendSerial(toSerial(checked.command), describe(checked.command))
    }
    if (result.reply) {
      log({ kind: 'llm', text: `回复: ${result.reply}` })
      speak(result.reply)
      return
    }
  } finally {
    busy = false
  }
}

export function registerIpcHandlers() {
  loadConfig()

  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:save', (_, config) => saveConfig(config))

  // UI 急停按钮（不等语音，直接停）
  ipcMain.handle('cmd:estop', () => {
    if (busy) busy = false
    emergencyStop('按钮急停')
    setState(sessionMode === 'auto' ? 'listening' : 'idle')
    return { ok: true }
  })

  ipcMain.handle('session:start', async (_, mode) => {
    sessionMode = mode
    audioBuffer = []
    busy = false
    try {
      setState('processing')
      log({ kind: 'info', text: '加载语音模型…' })
      initAll(getConfig().ttsVoice)
      setState('listening')
      log({ kind: 'info', text: mode === 'auto' ? '已开始：免按键（说完自动识别）' : '已开始：按住说话' })
      return { ok: true }
    } catch (e) {
      log({ kind: 'err', text: `语音引擎启动失败: ${e.message}` })
      setState('idle')
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('session:end', () => {
    sessionMode = null
    audioBuffer = []
    busy = false
    destroyAll()
    setState('idle')
    log({ kind: 'info', text: '已停止聆听' })
    return { ok: true }
  })

  ipcMain.handle('audio:send', async (_, arrayBuffer) => {
    const float32 = new Float32Array(arrayBuffer)

    // 处理期间仍然盯急停热词（auto 模式）
    if (busy && sessionMode === 'auto') {
      for (const seg of feedAudioToVAD(float32)) {
        if (seg.samples.length > 16000 * 2) continue
        const text = await recognize(seg.samples)
        if (text && matchStop(text)) {
          busy = false
          emergencyStop('语音急停')
          setState('listening')
          break
        }
      }
      return { ok: true }
    }

    if (sessionMode === 'auto') {
      const segments = feedAudioToVAD(float32)
      if (segments.length > 0) {
        if (currentState === 'listening') setState('recording')
        for (const seg of segments) {
          await handleText(await recognize(seg.samples))
        }
        if (currentState !== 'speaking') setState('listening')
      }
    } else {
      // 按住说话：攒音频
      if (currentState === 'listening') setState('recording')
      audioBuffer.push(float32)
    }
    return { ok: true }
  })

  ipcMain.handle('audio:stop', async () => {
    if (sessionMode === 'auto') {
      for (const seg of flushVAD()) {
        await handleText(recognizeAudio(seg.samples))
      }
      return { ok: true, text: '' }
    }

    // 按住说话：拼接整段识别
    if (audioBuffer.length === 0) {
      setState('idle')
      return { ok: true, text: '' }
    }
    const totalLen = audioBuffer.reduce((sum, buf) => sum + buf.length, 0)
    const merged = new Float32Array(totalLen)
    let offset = 0
    for (const buf of audioBuffer) {
      merged.set(buf, offset)
      offset += buf.length
    }
    audioBuffer = []

    log({ kind: 'info', text: '识别中…' })
    const text = await recognize(merged)
    if (text && text.trim()) {
      await handleText(text)
    } else {
      log({ kind: 'err', text: '没听清' })
      setState('idle')
    }
    return { ok: true, text }
  })

  ipcMain.handle('audio:playback-ended', () => {
    setState(sessionMode === 'auto' ? 'listening' : 'idle')
    return { ok: true }
  })
}
