import { app, BrowserWindow, session } from 'electron'
import { join } from 'path'
import { registerIpcHandlers, setMainWindow } from './ipc-handlers.js'
import { destroyAll } from './audio-engine.js'

let mainWindow

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 720,
    resizable: true,
    minWidth: 420,
    minHeight: 560,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  setMainWindow(mainWindow)

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Web Serial 权限：允许渲染进程直连 USB-TTL 串口
function setupSerialPermissions() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'serial'
  })
  session.defaultSession.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial'
  })
  // 有多个串口时自动选第一个（开发期够用；稳定后可换成弹窗选择）
  session.defaultSession.on('select-serial-port', (event, portList, _webContents, callback) => {
    event.preventDefault()
    console.log('[Serial] 可用串口:', portList.map(p => `${p.portId} ${p.displayName || ''} ${p.deviceInstanceId || ''}`))
    callback(portList[0]?.portId)
  })
}

app.whenReady().then(() => {
  setupSerialPermissions()
  registerIpcHandlers()
  createWindow()
})

app.on('window-all-closed', () => {
  destroyAll()
  app.quit()
})
