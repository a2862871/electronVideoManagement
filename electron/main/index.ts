import { app, BrowserWindow, shell, ipcMain, protocol, Menu } from 'electron'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { MEDIA_SCHEME, registerLibraryIpc, registerMediaProtocol } from './library/api'
import { openLibraryDb } from './library/db'
import * as repo from './library/repo'
import { THUMB_SCHEME, getThumbLoadMode, preloadThumbCache, registerThumbProtocol } from './library/thumbs'
import { startFolderWatcher, triggerScanOnFocus } from './library/watcher'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 仅在显式要求时禁用 GPU（无 GPU 的沙箱/CI 环境）。
// 用户桌面有显卡，禁用 GPU 会导致视频无法硬解播放，因此默认不禁用。
// 注意不要加 disable-software-rasterizer：它会连软件渲染一起禁掉，视频直接黑屏。
if (process.env.ELECTRON_DISABLE_GPU === '1') {
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.disableHardwareAcceleration()
}

// 最小化/遮挡后恢复窗口时，Chromium 默认会丢弃渲染层，恢复时需要整页重绘，
// 表现为"闪一下"。以下开关让页面在后台仍保留渲染状态，可明显减轻该现象。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.mjs   > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.APP_ROOT = path.join(__dirname, '../..')

export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
export const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL
  ? path.join(process.env.APP_ROOT, 'public')
  : RENDERER_DIST

// Disable GPU Acceleration for Windows 7
if (process.platform === 'win32' && os.release().startsWith('6.1')) app.disableHardwareAcceleration()

// 沙箱环境再次保险：disableHardwareAcceleration 已在顶部按环境条件设置

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

let win: BrowserWindow | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { secure: true, stream: true, supportFetchAPI: true } },
  { scheme: THUMB_SCHEME, privileges: { secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
])

async function createWindow() {
  win = new BrowserWindow({
    title: 'VideoLib',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    width: 1920,
    height: 1080,
    minWidth: 1280,
    minHeight: 720,
    // 隐藏原生标题栏，改用更矮的自定义标题栏（仅保留右上角窗口控制按钮）
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#020617',
      symbolColor: '#94a3b8',
      height: 32,
    },
    webPreferences: {
      preload,
      // 允许页面（http://localhost dev 或 file:// prod）直接加载 file:// 本地视频/图片。
      // 本地个人视频库工具，不加载外部不可信网页，风险可控。
      // 若后续要对外分发，需改回 true 并用自定义协议 + CORS。
      webSecurity: false,
    },
  })

  if (VITE_DEV_SERVER_URL) { // #298
    win.loadURL(VITE_DEV_SERVER_URL)
    // Open devTool if the app is not packaged
    win.webContents.openDevTools()
  } else {
    win.loadFile(indexHtml)
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString())
  })

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url)
    return { action: 'deny' }
  })
}

/**
 * 解析数据目录（数据库 + 缩略图 BLOB 所在位置）：
 * 1) 运行目录下 database-dir.json 的 dir 字段非空 → 用它（跨开发版/打包版共用同一个库）
 * 2) 否则回落「运行目录\database」（打包后=exe 旁；开发模式=项目根）
 * 配置目录不可创建（如 NAS 离线）时同样回落默认，保证应用总能启动。
 */
function resolveDataDir(): { dataDir: string; configFile: string } {
  const appRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()
  const configFile = path.join(appRoot, 'database-dir.json')
  let configured: string | null = null
  try {
    const j = JSON.parse(readFileSync(configFile, 'utf-8'))
    if (typeof j.dir === 'string' && j.dir.trim()) configured = path.resolve(j.dir.trim())
  } catch {
    // 无配置文件或格式不对 → 用默认目录
  }
  const fallback = path.join(appRoot, 'database')
  let dataDir = configured ?? fallback
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    dataDir = fallback
    mkdirSync(dataDir, { recursive: true })
  }
  // 确保引导文件始终存在（electron-builder extraFiles 打包时需要它存在）
  if (!existsSync(configFile)) {
    try {
      writeFileSync(configFile, JSON.stringify({ dir: configured ?? '' }, null, 2) + '\n')
    } catch {
      // 运行目录只读时跳过，不影响正常启动
    }
  }
  return { dataDir, configFile }
}

/** 广播「监控目录有变动」给所有窗口，触发前端刷新目录/视频列表。 */
function broadcastFoldersChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('folders:changed')
  }
}

app.whenReady().then(() => {
  // 移除默认菜单栏（File/Edit/View 等）
  Menu.setApplicationMenu(null)
  const { dataDir, configFile } = resolveDataDir()
  const db = openLibraryDb(path.join(dataDir, 'videolib.db'))
  repo.setSetting(db, 'dataDir', dataDir) // 供设置页展示当前库位置
  registerMediaProtocol()
  registerThumbProtocol(db)
  registerLibraryIpc(db, { dataDir, configFile })
  startFolderWatcher(db, broadcastFoldersChanged)
  // 按配置的缩略图加载模式决定是否启动时一次性载入内存
  if (getThumbLoadMode(db) === 'eager') preloadThumbCache(db)
  createWindow()
})

// 窗口聚焦时兜底：SMB 挂载下 fs.watch 可能漏掉部分事件，
// 切回应用时刷新界面并按节流自动扫描一次，保证新复制的文件及时入库。
app.on('browser-window-focus', () => {
  triggerScanOnFocus()
})

app.on('window-all-closed', () => {
  win = null
  if (process.platform !== 'darwin') app.quit()
})

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    createWindow()
  }
})

// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  })

  if (VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${VITE_DEV_SERVER_URL}#${arg}`)
  } else {
    childWindow.loadFile(indexHtml, { hash: arg })
  }
})
