import { ipcRenderer, contextBridge } from 'electron'

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args
    return ipcRenderer.on(channel, (event, ...args) => listener(event, ...args))
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args
    return ipcRenderer.off(channel, ...omit)
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args
    return ipcRenderer.send(channel, ...omit)
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args
    return ipcRenderer.invoke(channel, ...omit)
  },
})

contextBridge.exposeInMainWorld('api', {
  listFolders: () => ipcRenderer.invoke('folder:list'),
  listDirs: (dirPath: string) => ipcRenderer.invoke('dir:list', dirPath),
  addFolder: (args: { path: string; name: string; tagName: string | null; browseMode?: 'tree' | 'actor' }) => ipcRenderer.invoke('folder:add', args),
  setFolderMode: (args: { id: number; mode: 'tree' | 'actor' }) => ipcRenderer.invoke('folder:setMode', args),
  updateFolder: (args: { id: number; name: string; tagName: string | null }) => ipcRenderer.invoke('folder:update', args),
  removeFolder: (id: number) => ipcRenderer.invoke('folder:remove', id),
  deleteDir: (dirPath: string) => ipcRenderer.invoke('dir:delete', dirPath),
  createDir: (args: { parentPath: string; name: string }) => ipcRenderer.invoke('dir:create', args),
  toggleDirFavorite: (dirPath: string) => ipcRenderer.invoke('dir:toggleFavorite', dirPath),
  /** 移动整个文件夹（磁盘移动 + 数据库同步），返回移动的视频数 */
  moveDir: (args: { src: string; targetParent: string }) => ipcRenderer.invoke('dir:move', args),
  toggleActorFavorite: (actorId: number) => ipcRenderer.invoke('actor:toggleFavorite', actorId),
  getThumbLoadMode: () => ipcRenderer.invoke('thumbs:getMode'),
  setThumbLoadMode: (mode: 'eager' | 'lazy') => ipcRenderer.invoke('thumbs:setMode', mode),
  /** 监控目录有变动（文件增删改 / 窗口聚焦兜底），返回取消订阅函数 */
  onFoldersChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on('folders:changed', listener)
    return () => ipcRenderer.off('folders:changed', listener)
  },
  pickDirectory: () => ipcRenderer.invoke('folder:pick'),
  scan: (args?: { folderId?: number; dirPath?: string }) => ipcRenderer.invoke('scan:run', args),
  queryVideos: (q: Record<string, unknown>) => ipcRenderer.invoke('videos:query', q),
  getVideo: (id: number) => ipcRenderer.invoke('video:get', id),
  /** 保存视频画面旋转角度（0/90/180/270），下次打开自动应用 */
  setVideoRotation: (args: { id: number; rotation: number }) => ipcRenderer.invoke('video:setRotation', args),
  updateVideo: (args: Record<string, unknown>) => ipcRenderer.invoke('video:update', args),
  batchUpdateVideos: (args: Record<string, unknown>) => ipcRenderer.invoke('video:batchUpdate', args),
  listTags: () => ipcRenderer.invoke('tags:list'),
  createTag: (name: string) => ipcRenderer.invoke('tags:create', name),
  renameTag: (args: { id: number; name: string }) => ipcRenderer.invoke('tags:rename', args),
  deleteTag: (id: number) => ipcRenderer.invoke('tags:delete', id),
  listActors: (folderId?: number) => ipcRenderer.invoke('actors:list', folderId),
  setActorAlias: (args: { id: number; alias: string }) => ipcRenderer.invoke('actors:setAlias', args),
  createActor: (name: string) => ipcRenderer.invoke('actors:create', name),
  cleanupEmptyActors: () => ipcRenderer.invoke('actors:cleanup'),
  mergeActors: (args: { targetId: number; sourceId: number }) => ipcRenderer.invoke('actors:merge', args),
  openInPlayer: (filePath: string) => ipcRenderer.invoke('shell:openInPlayer', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('shell:showInFolder', filePath),
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (args: { key: string; value: string }) => ipcRenderer.invoke('settings:set', args),
  changeDbDir: (dirPath: string) => ipcRenderer.invoke('db:changeDir', dirPath),
  pickFile: (opts?: { filters?: { name: string; extensions: string[] }[] }) => ipcRenderer.invoke('file:pick', opts),
  grabPreview: (args: { videoPath: string; timeSec: number }) => ipcRenderer.invoke('ffmpeg:grabPreview', args),
  grabFrame: (args: { videoPath: string; videoId: number; timeSec: number }) => ipcRenderer.invoke('ffmpeg:grabFrame', args),
  getCompressConfig: () => ipcRenderer.invoke('compress:getConfig'),
  setCompressConfig: (cfg: unknown) => ipcRenderer.invoke('compress:setConfig', cfg),
  /** 开始后台压缩（串行队列），完成后用新文件替换原文件 */
  startCompress: (videos: { id: number; path: string; filename: string }[]) =>
    ipcRenderer.invoke('compress:start', videos),
  cancelCompress: () => ipcRenderer.invoke('compress:cancel'),
  onCompressProgress: (cb: (p: CompressProgress) => void) => {
    const listener = (_event: unknown, p: CompressProgress) => cb(p)
    ipcRenderer.on('compress:progress', listener as never)
    return () => ipcRenderer.off('compress:progress', listener as never)
  },
  /** 一键补全：缺缩略图补缩略图，缺时长补时长，都有则跳过 */
  batchCompleteMedia: (videos: { id: number; path: string }[]) => ipcRenderer.invoke('ffmpeg:batchMedia', videos),
  onBatchMediaProgress: (cb: (p: { done: number; total: number; current: string }) => void) => {
    const listener = (_event: unknown, p: { done: number; total: number; current: string }) => cb(p)
    ipcRenderer.on('ffmpeg:batchMedia:progress', listener as never)
    return () => ipcRenderer.off('ffmpeg:batchMedia:progress', listener as never)
  },
  moveVideo: (args: { id: number; targetDir: string }) => ipcRenderer.invoke('video:move', args),
  renameVideo: (args: { id: number; newName: string }) => ipcRenderer.invoke('video:rename', args),
  deleteVideo: (id: number) => ipcRenderer.invoke('video:delete', id),
  deleteVideos: (ids: number[]) => ipcRenderer.invoke('video:deleteMany', ids),
})

// --------- Preload scripts loading ---------
function domReady(condition: DocumentReadyState[] = ['complete', 'interactive']) {
  return new Promise(resolve => {
    if (condition.includes(document.readyState)) {
      resolve(true)
    } else {
      document.addEventListener('readystatechange', () => {
        if (condition.includes(document.readyState)) {
          resolve(true)
        }
      })
    }
  })
}

const safeDOM = {
  append(parent: HTMLElement, child: HTMLElement) {
    if (!Array.from(parent.children).find(e => e === child)) {
      return parent.appendChild(child)
    }
  },
  remove(parent: HTMLElement, child: HTMLElement) {
    if (Array.from(parent.children).find(e => e === child)) {
      return parent.removeChild(child)
    }
  },
}

/**
 * https://tobiasahlin.com/spinkit
 * https://connoratherton.com/loaders
 * https://projects.lukehaas.me/css-loaders
 * https://matejkustec.github.io/SpinThatShit
 */
function useLoading() {
  const className = `loaders-css__square-spin`
  const styleContent = `
@keyframes square-spin {
  25% { transform: perspective(100px) rotateX(180deg) rotateY(0); }
  50% { transform: perspective(100px) rotateX(180deg) rotateY(180deg); }
  75% { transform: perspective(100px) rotateX(0) rotateY(180deg); }
  100% { transform: perspective(100px) rotateX(0) rotateY(0); }
}
.${className} > div {
  animation-fill-mode: both;
  width: 50px;
  height: 50px;
  background: #fff;
  animation: square-spin 3s 0s cubic-bezier(0.09, 0.57, 0.49, 0.9) infinite;
}
.app-loading-wrap {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #282c34;
  z-index: 9;
}
    `
  const oStyle = document.createElement('style')
  const oDiv = document.createElement('div')

  oStyle.id = 'app-loading-style'
  oStyle.innerHTML = styleContent
  oDiv.className = 'app-loading-wrap'
  oDiv.innerHTML = `<div class="${className}"><div></div></div>`

  return {
    appendLoading() {
      safeDOM.append(document.head, oStyle)
      safeDOM.append(document.body, oDiv)
    },
    removeLoading() {
      safeDOM.remove(document.head, oStyle)
      safeDOM.remove(document.body, oDiv)
    },
  }
}

// ----------------------------------------------------------------------

const { appendLoading, removeLoading } = useLoading()
domReady().then(appendLoading)

window.onmessage = (ev) => {
  ev.data.payload === 'removeLoading' && removeLoading()
}

setTimeout(removeLoading, 4999)