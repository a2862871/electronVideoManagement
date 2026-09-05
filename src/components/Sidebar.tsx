import { useCallback, useEffect, useMemo, useState } from 'react'
import { useDialog } from './DialogProvider'
import ContextMenu from './ContextMenu'
import type { ActorDto, DirEntryDto, WatchFolderDto } from '../type/library'
import { VIDEO_DND_MIME } from './VideoGrid'

/** 目录排序拖拽的 MIME（与视频卡片拖放 VIDEO_DND_MIME 分流） */
const DIR_DND_MIME = 'application/x-videolib-dirdnd'
/** 手动目录顺序的 settings 键：{ [basePath]: string[] }（路径数组） */
const DIR_ORDERS_KEY = 'dirOrders'
/** 演员排序拖拽的 MIME */
const ACTOR_DND_MIME = 'application/x-videolib-actordnd'
/** 手动演员顺序的 settings 键：{ [folderId]: number[] }（演员 id 数组） */
const ACTOR_ORDERS_KEY = 'actorOrders'
/** 主目录排序拖拽的 MIME */
const FOLDER_DND_MIME = 'application/x-videolib-folderdnd'
/** 手动主目录顺序的 settings 键：number[]（文件夹 id 数组，全局一份） */
const FOLDER_ORDERS_KEY = 'folderOrders'

export interface Filters {
  folderId?: number
  /** 多标签筛选：同时包含这些标签的视频 */
  tagIds?: number[]
  actorId?: number
  dirPath?: string
}

/** 卡片拖拽携带的数据（VideoGrid onDragStart 写入） */
export interface VideoDndPayload {
  /** 整组视频 id（同番号多集一起移动） */
  ids: number[]
  /** 所属主目录 id（用于校验目标目录在同一主目录内） */
  folderId: number
}

interface Props {
  folders: WatchFolderDto[]
  /** null = 尚未选择任何目录（不点亮「全部视频」，App 也不加载视频列表） */
  filters: Filters | null
  onChange(filters: Filters): void
  onManageActors(): void
  onManageTags(): void
  onOpenSettings(): void
  /** 当前主区视图：非 library（演员/标签管理、设置）时收起二级目录栏 */
  view: 'library' | 'tags' | 'actors' | 'settings'
  /** 目录树中子目录被删除后回调（用于刷新列表/清理失效筛选） */
  onDirDeleted?(): void
  /** 移动整个文件夹（改名/搼到其他目录），由 App 处理（选目标、调用后端、刷新） */
  onMoveDir?(src: string): void
  /** 视频卡片拖拽到目录节点 / 主目录上释放后回调 */
  onDropVideos?(payload: VideoDndPayload, dirPath: string): void
  /** 外部刷新信号（文件监听/聚焦兜底）：变化时重载所有目录栏 */
  refreshSignal?: number
}

const itemCls = (active: boolean) =>
  `w-full truncate rounded-lg px-3 py-1.5 text-left text-sm transition-all duration-150 ${
    active
      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 font-medium text-white shadow-md shadow-cyan-950/50'
      : 'text-slate-300 hover:bg-slate-800/70'
  }`

// 目录栏宽度持久化（localStorage）：键 = 主目录路径#栏序号
const COL_WIDTH_KEY = 'videolib.colWidths'
const COL_WIDTH_DEFAULT = 176
const COL_WIDTH_MIN = 96
const COL_WIDTH_MAX = 480

function loadColWidths(): Record<string, number> {
  try {
    const j = JSON.parse(localStorage.getItem(COL_WIDTH_KEY) ?? '{}')
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

/** 栏宽拖拽（共享）：按住右缘把手后跟随鼠标，松手时 onEnd 通知持久化。 */
function beginColumnResize(e: React.MouseEvent, startW: number, onResize: (w: number) => void, onEnd: () => void) {
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const onMove = (ev: MouseEvent) => {
    onResize(Math.min(COL_WIDTH_MAX, Math.max(COL_WIDTH_MIN, startW + ev.clientX - startX)))
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    onEnd()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}

/** 单列：列出 basePath 下的子目录，highlight 为当前选中项。子目录支持右键删除（需输入名称确认）、接收视频卡片拖放，右缘可拖拽调宽。 */
function Column({
  basePath,
  highlight,
  width,
  filterable = false,
  refreshKey = 0,
  onSelect,
  onDeleted,
  onRenamed,
  onMoveDir,
  onDropVideos,
  onResize,
  onResizeEnd,
}: {
  basePath: string
  highlight?: string
  width: number
  /** 顶部显示「过滤文件夹」输入框（仅第一栏开启） */
  filterable?: boolean
  /** 刷新信号：变化时重载本栏目录（视频拖拽移动后由 Sidebar 自增触发） */
  refreshKey?: number
  onSelect(path: string): void
  onDeleted?(): void
  /** 目录被重命名后回调（oldPath → newPath），供父级同步当前浏览路径 */
  onRenamed?(oldPath: string, newPath: string): void
  onMoveDir?(src: string): void
  onDropVideos?(payload: VideoDndPayload, dirPath: string): void
  onResize(newWidth: number): void
  onResizeEnd(): void
}) {
  const [dirs, setDirs] = useState<DirEntryDto[] | null>(null)
  // 文件夹名过滤（仅 filterable 栏使用）：即时过滤本栏列表，不影响视频列表
  const [dirFilter, setDirFilter] = useState('')
  // 右键菜单：{ x, y } 为点击位置，dir 为被右键的目录（空白处右键则无 dir）
  const [menu, setMenu] = useState<{ x: number; y: number; dir?: DirEntryDto } | null>(null)
  // 确认删除对话框
  const [pending, setPending] = useState<DirEntryDto | null>(null)
  const [confirmInput, setConfirmInput] = useState('')
  const [deleting, setDeleting] = useState(false)
  // 新建文件夹对话框
  const [createOpen, setCreateOpen] = useState(false)
  const [createInput, setCreateInput] = useState('')
  const [creating, setCreating] = useState(false)
  // 重命名文件夹对话框
  const [renameDir, setRenameDir] = useState<DirEntryDto | null>(null)
  const [renameInput, setRenameInput] = useState('')
  const [renaming, setRenaming] = useState(false)
  // 拖放悬停高亮：当前拖拽经过的目录路径（空白处 = basePath）
  const [dropHover, setDropHover] = useState<string | null>(null)
  // 手动目录顺序（settings.dirOrders）与排序拖拽状态
  const [dirOrder, setDirOrder] = useState<string[]>([])
  const [dragDir, setDragDir] = useState<string | null>(null)
  // 插入位置指示：`-${path}` = 目标上方，`+${path}` = 目标下方
  const [dropLine, setDropLine] = useState<string | null>(null)
  const { alert } = useDialog()

  const load = () => {
    setDirs(null)
    window.api.listDirs(basePath).then(setDirs)
    window.api.getSetting(DIR_ORDERS_KEY).then((raw) => {
      try {
        const all = JSON.parse(raw ?? '{}')
        setDirOrder(Array.isArray(all?.[basePath]) ? all[basePath].filter((s: unknown) => typeof s === 'string') : [])
      } catch {
        setDirOrder([])
      }
    })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basePath])

  // 外部刷新信号（视频拖拽移动后）：重载目录计数
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  /** 删除入口：空文件夹（count=0）直接删不确认；有视频的弹确认框。 */
  async function requestDelete(dir: DirEntryDto) {
    if ((dir.count ?? 0) === 0) {
      const r = await window.api.deleteDir(dir.path)
      if (!r.ok) {
        await alert({ title: '删除失败', message: r.error ?? '未知错误', danger: true })
        return
      }
      load()
      onDeleted?.()
      return
    }
    setPending(dir)
    setConfirmInput('')
  }

  async function doDelete() {
    if (!pending) return
    setDeleting(true)
    const r = await window.api.deleteDir(pending.path)
    setDeleting(false)
    const name = pending.name
    const hadVideos = (pending.count ?? 0) > 0
    setPending(null)
    setConfirmInput('')
    if (!r.ok) {
      await alert({ title: '删除失败', message: r.error ?? '未知错误', danger: true })
      return
    }
    load()
    onDeleted?.()
    // 空文件夹静默删除；有视频的才提示结果
    if (hadVideos) {
      await alert({
        title: '已删除',
        message: `已彻底删除「${name}」${r.removedVideos ? `，并移除 ${r.removedVideos} 条视频记录` : ''}`,
        confirmText: '知道了',
      })
    }
  }

  async function doCreate() {
    const n = createInput.trim()
    if (!n) return
    setCreating(true)
    const r = await window.api.createDir({ parentPath: basePath, name: n })
    setCreating(false)
    if (!r.ok) {
      await alert({ title: '创建失败', message: r.error ?? '未知错误', danger: true })
      return
    }
    setCreateOpen(false)
    setCreateInput('')
    load()
  }

  /** 重命名：磁盘改名 + 后端同步视频记录路径。成功后刷新本栏并通知父级同步浏览路径。 */
  async function doRename() {
    const dir = renameDir
    if (!dir) return
    const n = renameInput.trim()
    if (!n) return
    setRenaming(true)
    const r = await window.api.renameDir({ dirPath: dir.path, newName: n })
    setRenaming(false)
    if (!r.ok) {
      await alert({ title: '重命名失败', message: r.error ?? '未知错误', danger: true })
      return // 保留对话框让用户修正
    }
    const oldPath = dir.path
    const newPath = r.path ?? ''
    setRenameDir(null)
    if (r.renamed === false) return
    load()
    onRenamed?.(oldPath, newPath)
  }

  // 拖放辅助：仅接受 VideoLib 视频卡片的拖拽
  const acceptsDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(VIDEO_DND_MIME)

  function readPayload(e: React.DragEvent): VideoDndPayload | null {
    try {
      const j = JSON.parse(e.dataTransfer.getData(VIDEO_DND_MIME))
      if (Array.isArray(j.ids) && j.ids.length > 0 && Number.isInteger(j.folderId)) {
        return { ids: j.ids, folderId: j.folderId }
      }
    } catch {
      // 数据缺失/格式不对，忽略
    }
    return null
  }

  function handleDrop(e: React.DragEvent, dirPath: string) {
    e.preventDefault()
    e.stopPropagation()
    setDropHover(null)
    // 释放点若在具体目录按钮上则用该目录，否则（空白处）用栏的上级目录
    const btn = (e.target as Element).closest('button[data-drop]')
    const target = btn?.getAttribute('data-drop') ?? dirPath
    const payload = readPayload(e)
    if (!payload) return
    onDropVideos?.(payload, target)
    load() // 移动后各目录计数会变化，重载本栏
  }

  /** 把手动顺序写入 settings.dirOrders（读改写全量 JSON）。 */
  function saveDirOrder(list: string[]) {
    setDirOrder(list)
    window.api.getSetting(DIR_ORDERS_KEY).then((raw) => {
      let all: Record<string, string[]> = {}
      try { all = JSON.parse(raw ?? '{}') } catch { /* 损坏则重建 */ }
      all[basePath] = list
      window.api.setSetting({ key: DIR_ORDERS_KEY, value: JSON.stringify(all) })
    })
  }

  /** 目录排序：收藏永远置顶（组内再套手动顺序或名称序）；末段应用文件夹名过滤（仅第一栏）。 */
  const sortedDirs = useMemo(() => {
    if (!dirs) return null
    const byName = (a: DirEntryDto, b: DirEntryDto) => a.name.localeCompare(b.name, 'zh-Hans-CN')
    // 组内排序：有手动顺序时按其排（缺省项落尾按名称序），否则按名称序
    const withinGroup = (arr: DirEntryDto[]): DirEntryDto[] => {
      if (dirOrder.length === 0) return [...arr].sort(byName)
      const idx = new Map(dirOrder.map((p, i) => [p, i]))
      return [...arr].sort((a, b) => {
        const ia = idx.get(a.path) ?? dirOrder.length
        const ib = idx.get(b.path) ?? dirOrder.length
        return ia !== ib ? ia - ib : byName(a, b)
      })
    }
    const favs = withinGroup(dirs.filter((d) => d.favorite))
    const rest = withinGroup(dirs.filter((d) => !d.favorite))
    const list = [...favs, ...rest]
    const q = dirFilter.trim().toLowerCase()
    return q ? list.filter((d) => d.name.toLowerCase().includes(q)) : list
  }, [dirs, dirOrder, dirFilter])

  // 加载完且没有子目录 → 整栏不显示（必须在所有 hooks 之后，避免 hooks 数量变化导致 React 崩溃白屏）
  if (dirs !== null && dirs.length === 0) return null

  async function toggleFavorite(dir: DirEntryDto) {
    await window.api.toggleDirFavorite(dir.path)
    load()
  }

  return (
    <div
      className='relative shrink-0 space-y-0.5 overflow-y-auto border-r border-slate-800/60 p-2'
      style={{ width }}
      onContextMenu={(e) => {
        // 仅空白处右键（未命中目录项）时弹出「新建文件夹」菜单
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      onDragOver={(e) => {
        const types = e.dataTransfer.types
        // 视频卡片拖放：高亮目标目录（原有逻辑）
        if (types.includes(VIDEO_DND_MIME)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const btn = (e.target as Element).closest('button[data-drop]')
          setDropHover(btn?.getAttribute('data-drop') ?? basePath)
          return
        }
        // 目录排序拖拽：按鼠标相对目标中线位置显示插入线
        if (types.includes(DIR_DND_MIME) && dragDir) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const btn = (e.target as Element).closest('button[data-drop]') as HTMLElement | null
          if (!btn) {
            setDropLine(null)
            return
          }
          const path = btn.getAttribute('data-drop') ?? ''
          const rect = btn.getBoundingClientRect()
          const after = e.clientY > rect.top + rect.height / 2
          setDropLine(`${after ? '+' : '-'}${path}`)
        }
      }}
      onDragLeave={() => {
        setDropHover(null)
        setDropLine(null)
      }}
      onDrop={(e) => {
        // 目录排序拖拽：按插入线位置重排并持久化
        if (e.dataTransfer.types.includes(DIR_DND_MIME)) {
          e.preventDefault()
          e.stopPropagation()
          const from = dragDir
          const line = dropLine
          setDragDir(null)
          setDropLine(null)
          if (!from || !line) return
          const after = line.startsWith('+')
          const target = line.slice(1)
          if (target === from) return
          const list = (sortedDirs ?? []).map((d) => d.path).filter((p) => p !== from)
          let i = list.indexOf(target)
          if (i < 0) return
          if (after) i++
          list.splice(i, 0, from)
          saveDirOrder(list)
          return
        }
        // 视频卡片拖放（原有逻辑）
        handleDrop(e, basePath)
      }}
    >
      {/* 右缘拖拽调宽把手（细条，悬停高亮） */}
      <div
        className='absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-cyan-500/40'
        title='拖动调整栏宽'
        onMouseDown={(e) => beginColumnResize(e, width, onResize, onResizeEnd)}
      />
      {dirs === null && <div className='px-1 py-1 text-xs text-slate-600'>读取中…</div>}
      {filterable && dirs !== null && dirs.length > 0 && (
        <div className='relative mb-1.5'>
          <input
            className='w-full rounded-lg border border-slate-700 bg-slate-900 py-1 pl-2 pr-6 text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none'
            placeholder='过滤文件夹…'
            value={dirFilter}
            onChange={(e) => setDirFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setDirFilter('')}
          />
          {dirFilter && (
            <button
              className='absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-200'
              title='清除过滤'
              onClick={() => setDirFilter('')}
            >
              ✕
            </button>
          )}
        </div>
      )}
      {filterable && dirs !== null && dirs.length > 0 && sortedDirs?.length === 0 && (
        <div className='px-1 py-1 text-xs text-slate-600'>无匹配文件夹</div>
      )}
      {sortedDirs?.map((d) => (
        <button
          key={d.path}
          className={`${itemCls(highlight === d.path)} ${dropHover === d.path ? 'ring-1 ring-cyan-400' : ''} ${dropHover === basePath && highlight !== d.path ? 'opacity-60' : ''} ${dropLine === `-${d.path}` ? 'shadow-[inset_0_2px_0_#22d3ee]' : ''} ${dropLine === `+${d.path}` ? 'shadow-[inset_0_-2px_0_#22d3ee]' : ''} ${dragDir === d.path ? 'opacity-40' : ''}`}
          title={d.name}
          data-drop={d.path}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(DIR_DND_MIME, d.path)
            setDragDir(d.path)
          }}
          onDragEnd={() => {
            setDragDir(null)
            setDropLine(null)
          }}
          onClick={() => onSelect(d.path)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, dir: d })
          }}
        >
          {d.favorite && <span className='mr-0.5 text-[10px] text-amber-400'>★</span>}
          {d.name}
          <span className='ml-1 text-xs opacity-60'>{d.count}</span>
        </button>
      ))}

      {/* 右键菜单（portal 到 body，避免被侧边栏裁剪/错位） */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} className='w-44'>
          <button
            className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
            onClick={() => {
              setCreateInput('')
              setCreateOpen(true)
              setMenu(null)
            }}
          >
            新建文件夹…
          </button>
          {dirOrder.length > 0 && (
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-300 hover:bg-slate-800'
              onClick={() => {
                saveDirOrder([])
                setMenu(null)
              }}
            >
              恢复名称排序
            </button>
          )}
          {menu.dir && (
            <>
              <button
                className='block w-full px-4 py-2 text-left text-sm text-amber-300 hover:bg-slate-800'
                onClick={() => {
                  const dir = menu.dir!
                  setMenu(null)
                  toggleFavorite(dir)
                }}
              >
                {menu.dir.favorite ? '取消收藏' : '收藏文件夹'}
              </button>
              {onMoveDir && (
                <button
                  className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
                  onClick={() => {
                    const dir = menu.dir!
                    setMenu(null)
                    onMoveDir(dir.path)
                  }}
                >
                  移动文件夹…
                </button>
              )}
              <button
                className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
                onClick={() => {
                  const dir = menu.dir!
                  setMenu(null)
                  setRenameDir(dir)
                  setRenameInput(dir.name)
                }}
              >
                重命名文件夹…
              </button>
              <button
                className='block w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-red-950/60'
                onClick={() => {
                  const dir = menu.dir!
                  setMenu(null)
                  requestDelete(dir)
                }}
              >
                {(menu.dir.count ?? 0) === 0 ? '删除空文件夹' : '删除整个文件夹…'}
              </button>
            </>
          )}
        </ContextMenu>
      )}

      {/* 新建文件夹对话框 */}
      {createOpen && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6'>
          <div className='w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5'>
            <div className='text-lg font-semibold text-slate-100'>新建文件夹</div>
            <div className='truncate text-xs text-slate-500'>{basePath}</div>
            <input
              className='w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
              placeholder='文件夹名'
              value={createInput}
              autoFocus
              onChange={(e) => setCreateInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && doCreate()}
            />
            <div className='flex justify-end gap-2'>
              <button
                className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900'
                onClick={() => { setCreateOpen(false); setCreateInput('') }}
              >
                取消
              </button>
              <button
                className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40'
                disabled={!createInput.trim() || creating}
                onClick={doCreate}
              >
                {creating ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名文件夹对话框 */}
      {renameDir && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6'>
          <div className='w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5'>
            <div className='text-lg font-semibold text-slate-100'>重命名文件夹</div>
            <div className='truncate text-xs text-slate-500'>{renameDir.path}</div>
            <input
              className='w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
              placeholder='文件夹名'
              value={renameInput}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && renameInput.trim() && !renaming && doRename()}
            />
            <div className='text-xs leading-relaxed text-slate-500'>
              将同步更新该文件夹下全部视频的路径记录（包含子文件夹），正在浏览该目录时视图会自动跟随新路径。
            </div>
            <div className='flex justify-end gap-2'>
              <button
                className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900'
                onClick={() => { setRenameDir(null); setRenameInput('') }}
              >
                取消
              </button>
              <button
                className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40'
                disabled={!renameInput.trim() || renameInput.trim() === renameDir.name || renaming}
                onClick={doRename}
              >
                {renaming ? '重命名中…' : '确认重命名'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 输入确认删除对话框 */}
      {pending && (
        <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6'>
          <div className='w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5'>
            <div className='text-lg font-semibold text-red-400'>删除文件夹（不可恢复）</div>
            <div className='text-sm text-slate-300'>
              将**彻底删除**文件夹 <span className='font-medium text-red-300'>{pending.name}</span>（{pending.count} 个视频）及其全部内容，不经过回收站。
            </div>
            <div className='truncate text-xs text-slate-500'>{pending.path}</div>
            <div className='space-y-1.5'>
              <div className='text-xs text-slate-400'>为防误删，请输入文件夹名称「<span className='text-slate-200'>{pending.name}</span>」以确认：</div>
              <input
                className='w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-red-500 focus:outline-none'
                value={confirmInput}
                autoFocus
                onChange={(e) => setConfirmInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirmInput === pending.name && doDelete()}
              />
            </div>
            <div className='flex justify-end gap-2'>
              <button
                className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900'
                onClick={() => { setPending(null); setConfirmInput('') }}
              >
                取消
              </button>
              <button
                className='rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-40'
                disabled={confirmInput !== pending.name || deleting}
                onClick={doDelete}
              >
                {deleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** 演员栏：列出某文件夹下的演员，点演员筛选其作品。支持收藏（置顶+星标）、拖拽排序、名称过滤。 */
function ActorColumn({
  folderId,
  activeActorId,
  width,
  refreshKey = 0,
  onSelect,
  onResize,
  onResizeEnd,
}: {
  folderId: number
  activeActorId?: number
  width: number
  refreshKey?: number
  onSelect(actorId: number | null): void
  onResize(newWidth: number): void
  onResizeEnd(): void
}) {
  const [actors, setActors] = useState<ActorDto[] | null>(null)
  const [filter, setFilter] = useState('')
  const [order, setOrder] = useState<number[]>([])
  const [dragId, setDragId] = useState<number | null>(null)
  const [dropLine, setDropLine] = useState<string | null>(null)
  // 右键菜单
  const [menu, setMenu] = useState<{ x: number; y: number; actor?: ActorDto } | null>(null)

  const load = () => {
    setActors(null)
    window.api.listActors(folderId).then(setActors)
    window.api.getSetting(ACTOR_ORDERS_KEY).then((raw) => {
      try {
        const all = JSON.parse(raw ?? '{}')
        setOrder(Array.isArray(all?.[folderId]) ? all[folderId].filter((n: unknown) => Number.isInteger(n)) : [])
      } catch {
        setOrder([])
      }
    })
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderId])

  // 外部刷新信号（文件监听/聚焦兜底）：重载演员列表
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  function saveOrder(list: number[]) {
    setOrder(list)
    window.api.getSetting(ACTOR_ORDERS_KEY).then((raw) => {
      let all: Record<string, number[]> = {}
      try { all = JSON.parse(raw ?? '{}') } catch { /* 损坏则重建 */ }
      all[folderId] = list
      window.api.setSetting({ key: ACTOR_ORDERS_KEY, value: JSON.stringify(all) })
    })
  }

  // 排序：收藏永远置顶（组内再套手动顺序或名称序）；末段应用名称过滤。
  const sorted = useMemo(() => {
    if (!actors) return null
    const byName = (a: ActorDto, b: ActorDto) => a.name.localeCompare(b.name, 'zh-Hans-CN')
    const withinGroup = (arr: ActorDto[]): ActorDto[] => {
      if (order.length === 0) return [...arr].sort(byName)
      const idx = new Map(order.map((id, i) => [id, i]))
      return [...arr].sort((a, b) => {
        const ia = idx.get(a.id) ?? order.length
        const ib = idx.get(b.id) ?? order.length
        return ia !== ib ? ia - ib : byName(a, b)
      })
    }
    const favs = withinGroup(actors.filter((a) => a.favorite))
    const rest = withinGroup(actors.filter((a) => !a.favorite))
    const list = [...favs, ...rest]
    const q = filter.trim().toLowerCase()
    return q ? list.filter((a) => a.name.toLowerCase().includes(q)) : list
  }, [actors, order, filter])

  async function toggleFavorite(actor: ActorDto) {
    await window.api.toggleActorFavorite(actor.id)
    load()
  }

  // 没有演员（无 NFO / 未扫描）→ 整栏不显示（hooks 之后）
  if (actors !== null && actors.length === 0) return null

  return (
    <div
      className='relative shrink-0 space-y-0.5 overflow-y-auto border-r border-slate-800/60 p-2'
      style={{ width }}
      onContextMenu={(e) => {
        if ((e.target as Element).closest('button[data-actor]')) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(ACTOR_DND_MIME) || !dragId) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const btn = (e.target as Element).closest('button[data-actor]') as HTMLElement | null
        if (!btn) { setDropLine(null); return }
        const id = btn.getAttribute('data-actor') ?? ''
        const rect = btn.getBoundingClientRect()
        const after = e.clientY > rect.top + rect.height / 2
        setDropLine(`${after ? '+' : '-'}${id}`)
      }}
      onDragLeave={() => setDropLine(null)}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(ACTOR_DND_MIME)) return
        e.preventDefault()
        e.stopPropagation()
        const from = dragId
        const line = dropLine
        setDragId(null)
        setDropLine(null)
        if (!from || !line) return
        const after = line.startsWith('+')
        const target = Number(line.slice(1))
        if (target === from) return
        const list = (sorted ?? []).map((a) => a.id).filter((id) => id !== from)
        let i = list.indexOf(target)
        if (i < 0) return
        if (after) i++
        list.splice(i, 0, from)
        saveOrder(list)
      }}
    >
      {/* 右缘拖拽调宽把手 */}
      <div
        className='absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-cyan-500/40'
        title='拖动调整栏宽'
        onMouseDown={(e) => beginColumnResize(e, width, onResize, onResizeEnd)}
      />
      <button
        className={itemCls(activeActorId === undefined)}
        onClick={() => onSelect(null)}
      >
        全部作品
      </button>
      {actors !== null && actors.length > 0 && (
        <div className='relative mb-1.5'>
          <input
            className='w-full rounded-lg border border-slate-700 bg-slate-900 py-1 pl-2 pr-6 text-xs text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none'
            placeholder='过滤演员…'
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setFilter('')}
          />
          {filter && (
            <button
              className='absolute right-1.5 top-1/2 -translate-y-1/2 text-xs text-slate-500 hover:text-slate-200'
              title='清除过滤'
              onClick={() => setFilter('')}
            >
              ✕
            </button>
          )}
        </div>
      )}
      {actors === null && <div className='px-1 py-1 text-xs text-slate-600'>读取中…</div>}
      {sorted?.length === 0 && actors !== null && actors.length > 0 && (
        <div className='px-1 py-1 text-xs text-slate-600'>无匹配演员</div>
      )}
      {sorted?.map((a) => (
        <button
          key={a.id}
          className={`${itemCls(activeActorId === a.id)} ${dropLine === `-${a.id}` ? 'shadow-[inset_0_2px_0_#22d3ee]' : ''} ${dropLine === `+${a.id}` ? 'shadow-[inset_0_-2px_0_#22d3ee]' : ''} ${dragId === a.id ? 'opacity-40' : ''}`}
          title={a.alias ? `${a.name}（曾用名：${a.alias}）` : a.name}
          data-actor={a.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData(ACTOR_DND_MIME, String(a.id))
            setDragId(a.id)
          }}
          onDragEnd={() => { setDragId(null); setDropLine(null) }}
          onClick={() => onSelect(a.id)}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            setMenu({ x: e.clientX, y: e.clientY, actor: a })
          }}
        >
          {a.favorite && <span className='mr-0.5 text-[10px] text-amber-400'>★</span>}
          {a.name}
          <span className='ml-1 text-xs opacity-60'>{a.count}</span>
        </button>
      ))}

      {/* 右键菜单（portal 到 body，避免被侧边栏裁剪/错位） */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} className='w-44'>
          {menu.actor ? (
            <button
              className='block w-full px-4 py-2 text-left text-sm text-amber-300 hover:bg-slate-800'
              onClick={() => {
                const a = menu.actor!
                setMenu(null)
                toggleFavorite(a)
              }}
            >
              {menu.actor.favorite ? '取消收藏' : '收藏演员'}
            </button>
          ) : (
            order.length > 0 && (
              <button
                className='block w-full px-4 py-2 text-left text-sm text-slate-300 hover:bg-slate-800'
                onClick={() => { saveOrder([]); setMenu(null) }}
              >
                恢复名称排序
              </button>
            )
          )}
        </ContextMenu>
      )}
    </div>
  )
}

export default function Sidebar({ folders, filters, onChange, onManageActors, onManageTags, onOpenSettings, onDirDeleted, onMoveDir, onDropVideos, refreshSignal, view }: Props) {
  const folder = folders.find((f) => f.id === filters?.folderId)
  // 主目录按钮的拖放悬停高亮（拖到监控文件夹根 = 移到该文件夹根目录）
  const [dropFolder, setDropFolder] = useState<string | null>(null)
  // —— 主目录手动排序（拖拽重排，settings.folderOrders 持久化）——
  const [folderOrder, setFolderOrder] = useState<number[]>([])
  const [folderDragId, setFolderDragId] = useState<number | null>(null)
  // 插入线：'-id' = 目标上方，'+id' = 目标下方
  const [folderDropLine, setFolderDropLine] = useState<string | null>(null)
  // 目录栏刷新信号：移动视频后自增，强制各栏重载目录计数
  const [dirRefreshKey, setDirRefreshKey] = useState(0)
  // 各目录栏宽度（localStorage 记忆；'root' = 第 0 栏视图+主目录）
  const [colWidths, setColWidths] = useState<Record<string, number>>(loadColWidths)
  const saveColWidths = useCallback(() => {
    setColWidths((prev) => {
      try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(prev)) } catch { /* 存储满则忽略 */ }
      return prev
    })
  }, [])

  // 由 dirPath 还原逐级链路，用于渲染并列分栏
  const chain: { name: string; path: string }[] = []
  if (folder && filters?.dirPath && filters.dirPath.startsWith(folder.path)) {
    const sep = filters.dirPath.includes('\\') ? '\\' : '/'
    const rel = filters.dirPath.slice(folder.path.length).replace(/^[\\/]/, '')
    let acc = folder.path
    for (const seg of rel.split(/[\\/]/).filter(Boolean)) {
      acc = acc + sep + seg
      chain.push({ name: seg, path: acc })
    }
  }

  // 分栏定义：第 1 栏子目录 = 文件夹根；之后每栏 = 上一级选中项的子目录
  // actor 模式不显示目录分栏，改为演员栏
  const isActorMode = folder?.browseMode === 'actor'
  const dirColumns: { base: string; highlight?: string }[] = []
  if (folder && !isActorMode) {
    dirColumns.push({ base: folder.path, highlight: chain[0]?.path })
    chain.forEach((c, i) => dirColumns.push({ base: c.path, highlight: chain[i + 1]?.path }))
  }

  // 包装视频拖放：移动完成后自增 refreshKey，强制所有目录栏重载计数
  async function handleDropVideos(payload: VideoDndPayload, dirPath: string) {
    await onDropVideos?.(payload, dirPath)
    setDirRefreshKey((k) => k + 1)
  }

  /** 子目录被重命名后：若当前浏览路径在旧目录之下，切到新路径（触发右侧列表与目录链刷新） */
  function handleDirRenamed(oldPath: string, newPath: string) {
    if (!newPath) return
    const cur = filters?.dirPath
    if (cur && (cur === oldPath || cur.startsWith(oldPath + '\\') || cur.startsWith(oldPath + '/'))) {
      onChange({ ...filters, dirPath: newPath + cur.slice(oldPath.length) })
    }
  }

  // 启动时读取手动主目录顺序（settings.folderOrders）
  useEffect(() => {
    window.api.getSetting(FOLDER_ORDERS_KEY).then((raw) => {
      try {
        const arr = JSON.parse(raw ?? '[]')
        setFolderOrder(Array.isArray(arr) ? arr.filter((n: unknown) => Number.isInteger(n)) : [])
      } catch {
        setFolderOrder([])
      }
    })
  }, [])

  /** 把手动顺序写入 settings.folderOrders。 */
  function saveFolderOrder(list: number[]) {
    setFolderOrder(list)
    window.api.setSetting({ key: FOLDER_ORDERS_KEY, value: JSON.stringify(list) })
  }

  // 主目录显示顺序：有手动顺序按其排（缺省项落尾），否则按添加序（数据库 id 序）
  const sortedFolders = useMemo(() => {
    if (folderOrder.length === 0) return folders
    const idx = new Map(folderOrder.map((id, i) => [id, i]))
    return [...folders].sort((a, b) => (idx.get(a.id) ?? folderOrder.length) - (idx.get(b.id) ?? folderOrder.length))
  }, [folders, folderOrder])

  return (
    <div className='flex min-h-0 shrink-0 overflow-x-auto border-r border-slate-800/80 bg-slate-950/60 backdrop-blur-xl'>
      {/* 第 0 栏：视图 + 主目录（宽度可拖拽调整，localStorage 记忆） */}
      <div
        className='relative flex shrink-0 flex-col gap-3 overflow-y-auto p-2'
        style={{ width: colWidths['root'] ?? COL_WIDTH_DEFAULT }}
        onDragOver={(e) => {
          // 主目录排序拖拽：按鼠标相对目标中线位置显示插入线
          if (e.dataTransfer.types.includes(FOLDER_DND_MIME) && folderDragId != null) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            const btn = (e.target as Element).closest('button[data-folder]')
            if (!btn) { setFolderDropLine(null); return }
            const id = Number(btn.getAttribute('data-folder'))
            if (!Number.isInteger(id)) { setFolderDropLine(null); return }
            const rect = btn.getBoundingClientRect()
            const after = e.clientY > rect.top + rect.height / 2
            setFolderDropLine(`${after ? '+' : '-'}${id}`)
            return
          }
          if (!e.dataTransfer.types.includes(VIDEO_DND_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          const btn = (e.target as Element).closest('button[data-drop]')
          setDropFolder(btn?.getAttribute('data-drop') ?? null)
        }}
        onDragLeave={() => { setDropFolder(null); setFolderDropLine(null) }}
        onDrop={(e) => {
          // 主目录排序落下：按插入线重排并持久化
          if (e.dataTransfer.types.includes(FOLDER_DND_MIME)) {
            e.preventDefault()
            e.stopPropagation()
            const from = folderDragId
            const line = folderDropLine
            setFolderDragId(null)
            setFolderDropLine(null)
            if (from == null || !line) return
            const after = line.startsWith('+')
            const target = Number(line.slice(1))
            if (target === from) return
            const list = sortedFolders.map((f) => f.id).filter((id) => id !== from)
            let i = list.indexOf(target)
            if (i < 0) return
            if (after) i++
            list.splice(i, 0, from)
            saveFolderOrder(list)
            return
          }
          e.preventDefault()
          setDropFolder(null)
          const btn = (e.target as Element).closest('button[data-drop]')
          const dirPath = btn?.getAttribute('data-drop')
          if (!dirPath || !onDropVideos) return
          try {
            const j = JSON.parse(e.dataTransfer.getData(VIDEO_DND_MIME))
            if (Array.isArray(j.ids) && j.ids.length > 0 && Number.isInteger(j.folderId)) {
              onDropVideos({ ids: j.ids, folderId: j.folderId }, dirPath)
            }
          } catch {
            // 非 VideoLib 拖拽数据，忽略
          }
        }}
      >
        {/* 右缘拖拽调宽把手 */}
        <div
          className='absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-cyan-500/40'
          title='拖动调整栏宽'
          onMouseDown={(e) =>
            beginColumnResize(
              e,
              colWidths['root'] ?? COL_WIDTH_DEFAULT,
              (w) => setColWidths((prev) => ({ ...prev, root: w })),
              saveColWidths,
            )
          }
        />
        <div>
          <button
            className={itemCls(filters !== null && !filters.folderId && !filters.tagIds?.length && !filters.dirPath)}
            onClick={() => onChange({})}
          >
            全部视频
          </button>
        </div>
        <div className='space-y-0.5'>
          <div className='px-1 text-xs font-semibold tracking-wider text-slate-500'>主目录</div>
          {sortedFolders.map((f) => (
            <button
              key={f.id}
              className={`${itemCls(filters?.folderId === f.id)} ${dropFolder === f.path ? 'ring-1 ring-cyan-400' : ''} ${folderDropLine === `-${f.id}` ? 'shadow-[inset_0_2px_0_#22d3ee]' : ''} ${folderDropLine === `+${f.id}` ? 'shadow-[inset_0_-2px_0_#22d3ee]' : ''} ${folderDragId === f.id ? 'opacity-40' : ''}`}
              title={f.path}
              data-drop={f.path}
              data-folder={f.id}
              draggable
              onDragStart={(e) => {
                // 排序拖拽与"视频卡片投放到主目录"分流：只携带文件夹 id
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData(FOLDER_DND_MIME, String(f.id))
                setFolderDragId(f.id)
              }}
              onDragEnd={() => { setFolderDragId(null); setFolderDropLine(null) }}
              onClick={() => onChange({ folderId: f.id, actorId: filters?.actorId, tagIds: filters?.tagIds })}
            >
              {f.name}
              {f.tagName ? <span className='ml-1 text-xs opacity-60'>#{f.tagName}</span> : null}
            </button>
          ))}
          {folders.length === 0 && <div className='px-1 text-xs text-slate-600'>尚未添加文件夹</div>}
        </div>
        <div className='mt-auto space-y-0.5'>
          <button className={itemCls(false)} onClick={onManageActors}>
            演员管理
          </button>
          <button className={itemCls(false)} onClick={onManageTags}>
            标签管理
          </button>
          <button className={itemCls(false)} onClick={onOpenSettings}>
            设置
          </button>
        </div>
      </div>

      {/* actor 模式：演员栏（替代目录分栏；支持收藏/排序/过滤，宽度可拖拽）；管理/设置界面时收起 */}
      {view === 'library' && isActorMode && folder && (
        <ActorColumn
          folderId={folder.id}
          activeActorId={filters?.actorId}
          width={colWidths['actor'] ?? COL_WIDTH_DEFAULT}
          refreshKey={dirRefreshKey + (refreshSignal ?? 0)}
          onSelect={(actorId) =>
            onChange(actorId == null ? { folderId: folder.id } : { folderId: folder.id, actorId })
          }
          onResize={(w) => setColWidths((prev) => ({ ...prev, actor: w }))}
          onResizeEnd={saveColWidths}
        />
      )}

      {/* tree 模式：后续分栏，二级、三级……子目录（宽度可拖拽，按主目录+栏序号记忆；第一栏带文件夹过滤框）；管理/设置界面时收起 */}
      {view === 'library' && !isActorMode && dirColumns.map((col, i) => {
        const folderPath = folder?.path ?? ''
        const wKey = `${folderPath}#${i}`
        return (
          <Column
            key={col.base}
            basePath={col.base}
            highlight={col.highlight}
            width={colWidths[wKey] ?? COL_WIDTH_DEFAULT}
            filterable={i === 0}
            refreshKey={dirRefreshKey + (refreshSignal ?? 0)}
            onSelect={(p) => onChange({ folderId: filters?.folderId, dirPath: p })}
            onDeleted={onDirDeleted}
            onRenamed={handleDirRenamed}
            onMoveDir={onMoveDir}
            onDropVideos={handleDropVideos}
            onResize={(w) => setColWidths((prev) => ({ ...prev, [wKey]: w }))}
            onResizeEnd={() =>
              // 函数式更新拿最新宽度后落盘（updater 幂等，重复写无害）
              setColWidths((prev) => {
                try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(prev)) } catch { /* 存储满则忽略 */ }
                return prev
              })
            }
          />
        )
      })}
    </div>
  )
}
