import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // 音频：麦克风块送给主进程做 VAD + ASR
  sendAudio: (float32Array) => {
    const copy = new ArrayBuffer(float32Array.byteLength)
    new Float32Array(copy).set(float32Array)
    return ipcRenderer.invoke('audio:send', copy)
  },
  stopRecording: () => ipcRenderer.invoke('audio:stop'),

  // 会话
  startSession: (mode) => ipcRenderer.invoke('session:start', mode), // 'auto' | 'ptt'
  endSession: () => ipcRenderer.invoke('session:end'),

  // 急停按钮（直达主进程，同时由主进程广播 $DST!）
  estop: () => ipcRenderer.invoke('cmd:estop'),

  // 事件：主进程 → 渲染进程
  onStateChange: (cb) => ipcRenderer.on('state:change', (_, s) => cb(s)),
  onLog: (cb) => ipcRenderer.on('log', (_, entry) => cb(entry)),
  onPlayAudio: (cb) => ipcRenderer.on('audio:play', (_, buffer) => cb(buffer)),

  // 串口：主进程下发要写的指令串（渲染进程的 serial.js 实际写）
  onSerialWrite: (cb) => ipcRenderer.on('serial:write', (_, str) => cb(str)),

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),

  playbackEnded: () => ipcRenderer.invoke('audio:playback-ended'),

  removeAllListeners: () => {
    for (const ch of ['state:change', 'log', 'audio:play', 'serial:write']) {
      ipcRenderer.removeAllListeners(ch)
    }
  }
})
