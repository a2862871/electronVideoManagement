import { app, BrowserWindow, screen, shell, ipcMain, protocol, Menu, Tray, nativeImage, dialog } from 'electron'
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

// Windows 桌面通知（toast）必须设置 AppUserModelId 才能正常显示；
// 与 electron-builder 的 appId 保持一致，开发/打包版通知来源统一显示为应用名。
app.setAppUserModelId('com.videolib.app')

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
// 关闭行为：「缩小到托盘」时点关闭按钮只隐藏窗口，应用驻留托盘后台运行
let tray: Tray | null = null
let quitting = false
// 主库连接（whenReady 中创建），供关闭行为设置读取
let appDb: ReturnType<typeof openLibraryDb> | null = null
const preload = path.join(__dirname, '../preload/index.mjs')
const indexHtml = path.join(RENDERER_DIST, 'index.html')

/** 关闭行为设置：'tray' = 缩小到托盘；其余（含未设置）= 完全退出。 */
function getCloseAction(): 'tray' | 'exit' {
  try {
    return appDb && repo.getSetting(appDb, 'closeAction') === 'tray' ? 'tray' : 'exit'
  } catch {
    return 'exit'
  }
}

/** 显示并聚焦主窗口（托盘点击/双击、second-instance 共用）。 */
function showMainWindow(): void {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** 首次缩小到托盘时创建托盘图标：左键/双击恢复窗口，右键菜单可恢复或退出。 */
function ensureTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(path.join(process.env.VITE_PUBLIC, 'favicon.ico'))
  tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('VideoLib（仍在后台运行）')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ]))
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  // Windows 气泡提示（一次性）：让用户知道窗口只是收进了托盘，不是关闭
  if (process.platform === 'win32') {
    try {
      tray.displayBalloon({
        title: 'VideoLib 仍在后台运行',
        content: '已缩小到系统托盘，点击托盘图标可恢复窗口；后台压缩/扫描不会中断。',
      })
    } catch {
      // 气泡失败不影响功能
    }
  }
}

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { secure: true, stream: true, supportFetchAPI: true } },
  { scheme: THUMB_SCHEME, privileges: { secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } },
])

async function createWindow() {
  // 窗口默认尺寸：上限 2560×1440，但不超过屏幕工作区的 90%（避免窗口尺寸恰好等于
  // 屏幕逻辑分辨率时占满整屏、视觉上等同全屏），四周留出边距呈现为普通窗口。
  const work = screen.getPrimaryDisplay().workAreaSize
  const width = Math.min(2560, Math.round(work.width * 0.9))
  const height = Math.min(1440, Math.round(work.height * 0.9))
  win = new BrowserWindow({
    title: 'VideoLib',
    icon: path.join(process.env.VITE_PUBLIC, 'favicon.ico'),
    width,
    height,
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

  // 关闭行为：设置为「缩小到托盘」时拦截关闭，仅隐藏窗口（应用与后台任务继续运行）；
  // 真正退出（托盘菜单退出 / exit 模式关窗）时 quitting 已置位，直接放行。
  win.on('close', (e) => {
    if (!quitting && getCloseAction() === 'tray') {
      e.preventDefault()
      win?.hide()
      ensureTray()
    }
  })
}

/**
 * 解析数据目录（数据库 + 缩略图 BLOB 所在位置）：
 * 1) 运行目录下 database-dir.json 的 dir 字段非空 → 用它（跨开发版/打包版共用同一个库）
 * 2) 首次运行（无 database-dir.json）→ 弹目录选择框让用户指定存储位置；取消则用默认
 * 3) 其余情况 → 回落「运行目录\database」（打包后=exe 旁；开发模式=项目根）
 * 配置目录不可创建（如 NAS 离线）时同样回落默认，保证应用总能启动。
 * 选择结果（含取消）会写回引导文件，之后启动不再询问。
 */
async function resolveDataDir(): Promise<{ dataDir: string; configFile: string }> {
  const appRoot = app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath()
  const configFile = path.join(appRoot, 'database-dir.json')
  let configured: string | null = null
  try {
    const j = JSON.parse(readFileSync(configFile, 'utf-8'))
    if (typeof j.dir === 'string' && j.dir.trim()) configured = path.resolve(j.dir.trim())
  } catch {
    // 无配置文件或格式不对 → 用默认目录（下面按首次运行处理弹窗）
  }
  // 首次运行（引导文件不存在）：让用户自己选数据存储位置；取消/直接关闭则用默认
  if (!existsSync(configFile)) {
    const r = await dialog.showOpenDialog({
      title: '选择数据存储位置（数据库与缩略图将保存到这里，取消则使用程序目录下的 database 文件夹）',
      buttonLabel: '选择此目录',
      defaultPath: appRoot,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (!r.canceled && r.filePaths[0]) configured = path.resolve(r.filePaths[0])
  }
  const fallback = path.join(appRoot, 'database')
  let dataDir = configured ?? fallback
  try {
    mkdirSync(dataDir, { recursive: true })
  } catch {
    dataDir = fallback
    mkdirSync(dataDir, { recursive: true })
  }
  // 写回引导文件（首次运行无论选没选都写：取消时空 dir 表示「用户已选择默认」，下次不再询问）
  try {
    writeFileSync(configFile, JSON.stringify({ dir: configured ?? '' }, null, 2) + '\n')
  } catch {
    // 运行目录只读时跳过，不影响正常启动（下次启动会再次询问）
  }
  return { dataDir, configFile }
}

/** 广播「监控目录有变动」给所有窗口，触发前端刷新目录/视频列表。 */
function broadcastFoldersChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('folders:changed')
  }
}

app.whenReady().then(async () => {
  // 移除默认菜单栏（File/Edit/View 等）
  Menu.setApplicationMenu(null)
  const { dataDir, configFile } = await resolveDataDir() // 首次运行会弹目录选择框，需等待用户操作
  const db = openLibraryDb(path.join(dataDir, 'videolib.db'))
  appDb = db
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
    // Focus on the main window if the user tried to open another（含从托盘恢复隐藏的窗口）
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
})

// 任何途径的退出（托盘菜单 / exit 模式关窗 / 系统关机）都先置位，让 close 拦截放行
app.on('before-quit', () => {
  quitting = true
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
