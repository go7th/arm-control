/**
 * Web Serial：连接 USB-TTL 串口（机械臂 USART1，115200 8N1）
 * 只做三件事：连接 / 写指令字符串 / 读回显进日志
 */

let port = null
let writer = null
let reader = null
let readAbort = null

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function isConnected() {
  return !!port
}

export async function connect(baudRate = 115200, onLog) {
  if (port) return { ok: true }
  try {
    port = await navigator.serial.requestPort()
    await port.open({ baudRate })
    writer = port.writable.getWriter()
    readAbort = new AbortController()
    readLoop(onLog)
    const info = port.getInfo?.() || {}
    onLog?.({ kind: 'info', text: `串口已连接 (USB ${info.usbVendorId?.toString(16) || '?'}:${info.usbProductId?.toString(16) || '?'})` })
    return { ok: true }
  } catch (e) {
    port = null
    writer = null
    return { ok: false, error: e.message }
  }
}

export async function disconnect(onLog) {
  try {
    readAbort?.abort()
    reader?.cancel().catch(() => {})
    writer?.releaseLock?.()
    await port?.close()
  } catch { /* ignore */ }
  port = null
  writer = null
  reader = null
  onLog?.({ kind: 'info', text: '串口已断开' })
}

export async function write(str, onLog) {
  if (!writer) {
    onLog?.({ kind: 'err', text: `串口未连接，指令丢弃: ${str}` })
    return { ok: false, error: '串口未连接' }
  }
  try {
    await writer.write(encoder.encode(str))
    return { ok: true }
  } catch (e) {
    onLog?.({ kind: 'err', text: `串口写入失败: ${e.message}` })
    return { ok: false, error: e.message }
  }
}

// 读回显（固件应答 "A"、"@Group Done" 等），按行切开进日志
async function readLoop(onLog) {
  try {
    while (port?.readable && !readAbort?.signal.aborted) {
      reader = port.readable.getReader()
      try {
        let buf = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split(/\r?\n/)
          buf = lines.pop()
          for (const line of lines) {
            if (line.trim()) onLog?.({ kind: 'rx', text: line.trim() })
          }
        }
      } finally {
        reader.releaseLock()
        reader = null
      }
    }
  } catch { /* 断开时正常退出 */ }
}
