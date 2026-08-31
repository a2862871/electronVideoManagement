import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ActorPage from './components/ActorPage'
import BatchEditDialog from './components/BatchEditDialog'
import CaptureDialog from './components/CaptureDialog'
import RenameDialog from './components/RenameDialog'
import SettingsPage from './components/SettingsPage'
import Sidebar, { type Filters } from './components/Sidebar'
import TagPage from './components/TagPage'
import VideoDetail from './components/VideoDetail'
import VideoEditForm from './components/VideoEditForm'
import VideoGrid, { DEFAULT_COVER_H, groupByWork } from './components/VideoGrid'
import VideoTable from './components/VideoTable'
import { formatSizeGB } from './utils/media'
import type { ActorDto, CompressProgress, TagDto, VideoDetailDto, VideoDto, WatchFolderDto } from './type/library'

const PAGE_SIZE = 60

export default function App() {
  const [ready, setReady] = useState<boolean | null>(null)
  const [folders, setFolders] = useState<WatchFolderDto[]>([])
  const [tags, setTags] = useState<TagDto[]>([])
  const [actors, setActors] = useState<ActorDto[]>([])
  const [filters, setFilters] = useState<Filters>({})
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [rows, setRows] = useState<VideoDto[]>([])
  const [total, setTotal] = useState(0)
  const [scanning, setScanning] = useState(false)
  const [thumbing, setThumbing] = useState(false)
  const [thumbProgress, setThumbProgress] = useState<{ done: number; total: number; current: string } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [notice, setNotice] = useState('')
  const [openVideoId, setOpenVideoId] = useState<number | null>(null)
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; video: VideoDto } | null>(null)
  const [editVideo, setEditVideo] = useState<VideoDetailDto | null>(null)
  const [captureVideo, setCaptureVideo] = useState<{ videoPath: string; videoId: number } | null>(null)
  const [renameVideo, setRenameVideo] = useState<{ videoId: number; filename: string } | null>(null)
  const [showBatchEdit, setShowBatchEdit] = useState(false)
  const [view, setView] = useState<'library' | 'tags' | 'actors' | 'settings'>('library')
  // 目录栏外部刷新信号（文件监听/窗口聚焦触发）
  const [dirSignal, setDirSignal] = useState(0)
  // 框选选中的视频 id（用于批量删除/批量编辑）
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  // 所选视频的总大小（批量压缩前很有参考价值）
  const selectedTotalSize = useMemo(
    () => rows.reduce((sum, v) => sum + (selectedIds.has(v.id) ? (v.size_bytes ?? 0) : 0), 0),
    [rows, selectedIds],
  )
  const [batchDeleting, setBatchDeleting] = useState(false)
  // 预览卡片是否显示视频时长（设置项，默认开启）
  const [showDuration, setShowDuration] = useState(true)
  // 预览卡片是否显示文件大小（设置项，默认开启）
  const [showSize, setShowSize] = useState(true)
  // 预览方式：grid=瀑布流（封面）；list=列表（含大小/修改时间，便于批量选择）
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  // 封面基准高度（横图高度，设置项）
  const [coverH, setCoverH] = useState(DEFAULT_COVER_H)
  // 后台压缩进度（压缩在后台串行执行，可继续浏览/切页面）
  const [compress, setCompress] = useState<CompressProgress | null>(null)
  // 是否展开剩余待压缩文件列表
  const [showRemaining, setShowRemaining] = useState(false)

  const hasApi = typeof window.api !== 'undefined'
  const mainRef = useRef<HTMLElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const reloadMeta = useCallback(async () => {
    const [f, t, a] = await Promise.all([window.api.listFolders(), window.api.listTags(), window.api.listActors()])
    setFolders(f)
    setTags(t)
    setActors(a)
  }, [])

  // 读取显示设置（时长角标、大小角标、封面高度）；从设置页返回时同步最新值
  useEffect(() => {
    window.api.getSetting('showDuration').then((v) => setShowDuration(v !== '0'))
    window.api.getSetting('showSize').then((v) => setShowSize(v !== '0'))
    window.api.getSetting('viewMode').then((v) => setViewMode(v === 'list' ? 'list' : 'grid'))
    window.api.getSetting('coverHeight').then((v) => {
      const n = Number(v)
      setCoverH(Number.isFinite(n) && n > 0 ? n : DEFAULT_COVER_H)
    })
  }, [view])

  // 切换视图模式并持久化（立即生效）
  async function changeViewMode(mode: 'grid' | 'list') {
    setViewMode(mode)
    await window.api.setSetting({ key: 'viewMode', value: mode })
  }

  const reloadVideos = useCallback(async (offset = 0) => {
    const page = await window.api.queryVideos({
      search: search || undefined,
      folderId: filters.folderId,
      // 有搜索词时只按主目录限定范围：忽略演员/标签/子目录筛选（搜索结果 = 主目录）
      tagIds: search ? undefined : filters.tagIds,
      actorId: search ? undefined : filters.actorId,
      dirPath: search ? undefined : filters.dirPath,
      sort,
      limit: PAGE_SIZE,
      offset,
    })
    setRows((prev) => (offset === 0 ? page.rows : [...prev, ...page.rows]))
    setTotal(page.total)
  }, [search, filters, sort])

  useEffect(() => {
    if (!hasApi) {
      setReady(false)
      return
    }
    setReady(true)
    reloadMeta()
  }, [hasApi, reloadMeta])

  useEffect(() => {
    if (ready) reloadVideos(0)
  }, [ready, reloadVideos])

  // 订阅监控目录变更（文件增删改 / 窗口聚焦兜底）：刷新目录栏与视频列表
  useEffect(() => {
    if (!hasApi) return
    const off = window.api.onFoldersChanged(() => {
      setDirSignal((s) => s + 1)
      reloadVideos(0)
    })
    return off
  }, [hasApi, reloadVideos])

  // 切换筛选/目录时清空框选，避免残留选择误删当前不可见的视频
  useEffect(() => {
    setSelectedIds(new Set())
  }, [filters])

  // 订阅后台压缩进度
  useEffect(() => {
    if (!hasApi) return
    const off = window.api.onCompressProgress((p) => {
      if (p.finished) {
        setCompress(null)
        const parts: string[] = []
        if (p.cancelled) parts.push('压缩已取消')
        if (p.ok) parts.push(`已压缩替换 ${p.ok} 个`)
        if (p.skipped) parts.push(`${p.skipped} 个未变小已保留原文件`)
        if (p.failed?.length) parts.push(`失败 ${p.failed.length} 个（${p.failed[0].error.slice(0, 60)}${p.failed.length > 1 ? '…' : ''}）`)
        if (p.savedBytes && p.savedBytes > 0) parts.push(`共节省 ${(p.savedBytes / 1024 / 1024).toFixed(1)} MB`)
        flash(parts.join('，') || '压缩完成')
        reloadVideos(0)
        return
      }
      // 合并式更新：ffmpeg 编码期间的高频进度不带 remaining，
      // 直接覆盖会让"剩余队列"列表闪烁消失——未携带时保留上一次的值
      setCompress((prev) => ({ ...prev, ...p, remaining: p.remaining ?? prev?.remaining }))
    })
    return off
  }, [hasApi, reloadVideos])

  /** 发起压缩：支持单个（右键）与批量（框选）。后台执行，不阻塞界面。 */
  async function startCompress(videos: { id: number; path: string; filename: string }[]) {
    if (videos.length === 0) return
    const r = await window.api.startCompress(videos)
    if (r.started) {
      setCompress({
        filename: '准备中…',
        percent: 0,
        current: 0,
        total: videos.length,
        stage: '准备中',
        remaining: videos.map((v) => v.filename),
      })
    }
  }

  function flash(msg: string) {
    setNotice(msg)
    setTimeout(() => setNotice(''), 4000)
  }

  async function scan(args?: { folderId?: number; dirPath?: string }) {
    setScanning(true)
    const summaries = await window.api.scan(args)
    setScanning(false)
    const added = summaries.reduce((n, s) => n + s.added, 0)
    const removed = summaries.reduce((n, s) => n + s.removed, 0)
    const scanned = summaries.reduce((n, s) => n + s.scanned, 0)
    flash(
      args
        ? `已扫描所选目录：新增 ${added}，移除 ${removed}，共 ${scanned} 个文件`
        : `扫描完成：新增 ${added}，移除 ${removed}，共 ${scanned} 个文件`,
    )
    reloadMeta()
    reloadVideos(0)
  }

  // 批量移动多个视频到指定目录（不限制主目录范围；供拖拽投放/批量栏/右键菜单复用）
  async function moveManyToDir(ids: number[], dirPath: string) {
    let moved = 0
    let same = 0
    const errors: string[] = []
    for (const id of ids) {
      const r = await window.api.moveVideo({ id, targetDir: dirPath })
      if (!r.ok) {
        errors.push(r.error ?? '移动失败')
      } else if (r.moved === false) {
        same++
      } else {
        moved++
      }
    }
    const parts: string[] = []
    if (moved > 0) parts.push(`已移动 ${moved} 个`)
    if (same > 0) parts.push(`${same} 个已在目标目录`)
    if (errors.length > 0) parts.push(`${errors.length} 个失败`)
    flash(parts.join('，') || '没有需要移动的视频')
    if (errors.length > 0) console.warn('批量移动失败明细：', errors)
    if (moved > 0) {
      reloadMeta()
      reloadVideos(0)
    }
  }

  // 拖拽视频卡片到目录树释放：整组移动到目标目录（须在同一主目录范围内）
  async function moveVideosToDir(payload: { ids: number[]; folderId: number }, dirPath: string) {
    const owner = folders.find((f) => f.id === payload.folderId)
    if (owner && !dirPath.startsWith(owner.path)) {
      flash('只能在同一主目录范围内移动（跨目录请用右键「移动视频到…」）')
      return
    }
    await moveManyToDir(payload.ids, dirPath)
  }

  // 选中视频批量移动：弹目录选择框，把整个选中集合移动过去
  async function moveSelectedToDir() {
    if (selectedIds.size === 0) return
    const dir = await window.api.pickDirectory()
    if (!dir) return
    setSelectedIds(new Set())
    await moveManyToDir([...selectedIds], dir)
  }

  // 批量删除框选的视频（后端一次确认，直接删硬盘文件，不可恢复）
  async function deleteSelected() {
    if (selectedIds.size === 0 || batchDeleting) return
    setBatchDeleting(true)
    try {
      const r = await window.api.deleteVideos([...selectedIds])
      if (r.cancelled) return
      if (!r.ok) {
        flash(r.error ?? '删除失败')
        return
      }
      const msg = `已删除 ${r.deleted ?? 0} 个视频${r.failed?.length ? `，失败 ${r.failed.length} 个` : ''}`
      flash(r.failed?.length ? `${msg}（${r.failed[0].slice(0, 60)}${r.failed.length > 1 ? '…' : ''}）` : msg)
      setSelectedIds(new Set())
      setOpenVideoId(null)
      reloadMeta()
      reloadVideos(0)
    } finally {
      setBatchDeleting(false)
    }
  }

  // 移动整个文件夹：选目标父目录 → 后端磁盘移动 + 数据库同步 → 全量刷新
  async function moveDir(src: string) {
    const targetParent = await window.api.pickDirectory()
    if (!targetParent) return
    // 禁止移到自己内部（统一分隔符后做前缀判断；后端还有更严格校验兜底）
    const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase()
    const srcN = norm(src)
    const targetN = norm(targetParent)
    if (targetN === srcN || targetN.startsWith(srcN + '\\') || targetN.startsWith(srcN + '/')) {
      flash('目标位置不能位于源文件夹内部')
      return
    }
    const r = await window.api.moveDir({ src, targetParent })
    if (r.cancelled) return
    if (!r.ok) {
      flash(r.error ?? '移动失败')
      return
    }
    if (r.error) {
      // 部分文件移动失败（合并模式下可能发生，如目标文件被占用）
      flash(`已移动 ${r.moved ?? 0} 条记录，${r.error}`)
    } else {
      flash(`已移动文件夹（${r.moved ?? 0} 条视频记录同步更新）`)
    }
    // 当前浏览目录若在旧路径下，清除筛选避免空白列表
    if (filters.dirPath && filters.dirPath.startsWith(src)) setFilters((f) => ({ ...f, dirPath: undefined }))
    reloadMeta()
    reloadVideos(0)
    setDirSignal((s) => s + 1) // 刷新目录栏
  }

  // 一键补全：缺缩略图补缩略图、缺时长补时长，两者都有则跳过
  async function batchComplete() {
    if (rows.length === 0) return
    setThumbing(true)
    setThumbProgress({ done: 0, total: rows.length, current: '' })
    const off = window.api.onBatchMediaProgress((p) => setThumbProgress(p))
    const r = await window.api.batchCompleteMedia(rows.map((v) => ({ id: v.id, path: v.path })))
    off()
    setThumbing(false)
    setThumbProgress(null)
    if (r.cancelled) return
    const skipMsg = r.skipped > 0 ? `，跳过已完整 ${r.skipped} 个` : ''
    if (r.failed.length === 0) {
      flash(`已补全 ${r.ok} 个视频的信息${skipMsg}`)
    } else {
      const names = r.failed.slice(0, 3).map((f) => f.path.split(/[\\/]/).pop()).join('、')
      flash(`补全成功 ${r.ok} 个，失败 ${r.failed.length} 个${skipMsg}（如：${names}${r.failed.length > 3 ? '…' : ''}）`)
    }
    reloadVideos(0)
  }

  const loadMore = useCallback(async () => {
    if (loadingMore || rows.length >= total) return
    setLoadingMore(true)
    try {
      await reloadVideos(rows.length)
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, rows.length, total, reloadVideos])

  // 哨兵元素进入可视区域（提前 200px）时自动加载下一页，首屏不足一屏也会自动补满
  useEffect(() => {
    if (view !== 'library') return
    const sentinel = sentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore()
      },
      { root: mainRef.current, rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [view, loadMore])

  if (ready === false) {
    return (
      <div className='flex min-h-screen items-center justify-center bg-slate-950 text-slate-400'>
        请通过 Electron 启动应用（npm run dev）
      </div>
    )
  }

  // memo 化：rows 不变时复用同一数组，避免每次渲染都让瀑布流重算与全量重渲染
  const cards = useMemo(() => groupByWork(rows), [rows])

  // 搜索时的范围提示：主目录 + 叠加的演员/标签筛选
  const activeFolder = folders.find((f) => f.id === filters.folderId)

  return (
    <div className='flex h-screen flex-col text-slate-100'>
      <header className='titlebar flex flex-col border-b border-slate-800/80 bg-slate-950/60 pl-4 pr-36 backdrop-blur-xl'>
        <div className='flex items-center gap-3 py-2.5'>
        <div className='text-gradient text-base font-bold tracking-wide'>VideoLib</div>
        <input
          className='w-72 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm focus:border-cyan-500 focus:outline-none'
          placeholder='搜索标题 / 番号 / 文件名 / 演员'
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && reloadVideos(0)}
        />
        <select
          className='rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-sm text-slate-300 focus:border-cyan-500 focus:outline-none'
          value={sort}
          onChange={(e) => setSort(e.target.value as 'newest' | 'oldest')}
          title='按添加时间排序'
        >
          <option value='newest'>最新添加</option>
          <option value='oldest'>最早添加</option>
        </select>
        <div className='ml-auto flex items-center gap-2'>
          {notice && <span className='text-xs text-cyan-300'>{notice}</span>}
          <button
            className='btn-primary rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50'
            disabled={scanning}
            onClick={() => scan()}
          >
            {scanning ? '扫描中…' : '扫描'}
          </button>
          <button
            className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50'
            disabled={thumbing || rows.length === 0}
            onClick={batchComplete}
            title='为当前列表中缺少信息的视频补全：缺缩略图则抽帧生成，缺时长则用 FFmpeg 读取；两者都已具备的视频自动跳过'
          >
            {thumbing ? `处理中 ${thumbProgress?.done ?? 0}/${thumbProgress?.total ?? rows.length}…` : '一键补全信息'}
          </button>
          <button
            className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50'
            disabled={rows.length === 0}
            onClick={() => setShowBatchEdit(true)}
            title='对当前列表中的全部视频批量设置演员/标签等字段'
          >
            批量编辑
          </button>
        </div>
        </div>

        {/* 搜索范围提示条：搜索结果 = 当前主目录（演员/标签筛选暂停生效，但选中状态保留） */}
        {search && (
          <div className='flex items-center gap-2 pb-2 text-xs'>
            <span className='text-slate-500'>搜索范围：</span>
            <span className='inline-flex items-center gap-1.5 rounded-full bg-cyan-900/60 px-2.5 py-1 text-cyan-300'>
              {activeFolder ? `主目录：${activeFolder.name}` : '全部视频'}
              {activeFolder && (
                <button
                  className='text-cyan-200 hover:text-white'
                  title='切换为全局搜索'
                  onClick={() => setFilters((f) => ({ ...f, folderId: undefined, dirPath: undefined }))}
                >
                  ✕
                </button>
              )}
            </span>
            {(filters.actorId || filters.tagIds?.length) && (
              <span className='text-slate-600'>演员/标签筛选在搜索时暂停，清除搜索后自动恢复</span>
            )}
          </div>
        )}
      </header>

      {thumbing && thumbProgress && (
        <div className='border-b border-slate-800 bg-slate-900/60 px-4 py-2'>
          <div className='mb-1 flex items-center justify-between gap-4 text-xs text-slate-400'>
            <span>正在生成缩略图 {thumbProgress.done}/{thumbProgress.total}</span>
            <span className='truncate text-slate-500'>{thumbProgress.current}</span>
          </div>
          <div className='h-1.5 w-full overflow-hidden rounded-full bg-slate-800'>
            <div
              className='h-full rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500 shadow-[0_0_12px_rgba(34,211,238,0.6)] transition-all duration-200'
              style={{ width: `${thumbProgress.total === 0 ? 0 : Math.round((thumbProgress.done / thumbProgress.total) * 100)}%` }}
            />
          </div>
        </div>
      )}

      <div className='flex min-h-0 flex-1'>
        <Sidebar
          folders={folders}
          filters={filters}
          onChange={(f) => { setFilters(f); setView('library') }}
          onManageActors={() => setView('actors')}
          onManageTags={() => setView('tags')}
          onOpenSettings={() => setView('settings')}
          onDropVideos={moveVideosToDir}
          onMoveDir={moveDir}
          refreshSignal={dirSignal}
          onDirDeleted={() => {
            reloadMeta()
            reloadVideos(0)
          }}
        />
        <main ref={mainRef} className='min-w-0 flex-1 overflow-y-auto'>
          {view === 'actors' ? (
            <ActorPage
              actors={actors}
              onChanged={reloadMeta}
              onFilter={(actorId) => { setFilters({ actorId }); setView('library') }}
            />
          ) : view === 'tags' ? (
            <TagPage
              tags={tags}
              onChanged={reloadMeta}
              onFilter={(tagIds) => { setFilters({ tagIds }); setView('library') }}
            />
          ) : view === 'settings' ? (
            <SettingsPage
              folders={folders}
              onChanged={reloadMeta}
            />
          ) : (
            <>
              {/* 预览区首行：左侧过滤标签 + 右侧操作条（视图切换/扫描此目录）。固定高度并 sticky 置顶，滚动时始终吸在顶部 */}
              <div className='sticky top-0 z-20 flex h-[42px] items-center justify-between gap-2 bg-slate-950 px-4'>
                <div className='flex min-w-0 flex-1 flex-nowrap items-center gap-2 overflow-hidden'>
                  {!search && filters.dirPath && (
                    <span className='inline-flex items-center gap-2 rounded-full bg-cyan-900/60 px-3 py-1 text-xs text-cyan-300'>
                      目录：{filters.dirPath.split(/[\\/]/).filter(Boolean).pop()}
                      <button
                        className='text-cyan-200 hover:text-white'
                        onClick={() => setFilters((f) => ({ ...f, dirPath: undefined }))}
                      >
                        ✕
                      </button>
                    </span>
                  )}
                  {!search && filters.actorId && (
                    <span className='inline-flex items-center gap-2 rounded-full bg-cyan-900/60 px-3 py-1 text-xs text-cyan-300'>
                      演员：{actors.find((a) => a.id === filters.actorId)?.name ?? filters.actorId}
                      <button className='text-cyan-200 hover:text-white' onClick={() => setFilters((f) => ({ ...f, actorId: undefined }))}>
                        ✕
                      </button>
                    </span>
                  )}
                  {!search &&
                    filters.tagIds?.map((tagId) => (
                      <span key={tagId} className='inline-flex items-center gap-2 rounded-full bg-cyan-900/60 px-3 py-1 text-xs text-cyan-300'>
                        标签：{tags.find((t) => t.id === tagId)?.name ?? tagId}
                        <button
                          className='text-cyan-200 hover:text-white'
                          onClick={() => setFilters((f) => ({ ...f, tagIds: f.tagIds?.filter((id) => id !== tagId) }))}
                        >
                          ✕
                        </button>
                      </span>
                    ))}
                </div>
                <div className='flex shrink-0 items-center gap-2'>
                {/* 视图切换：瀑布流（2×2 方块）/ 列表（三横杠） */}
                <div className='flex overflow-hidden rounded-lg border border-slate-700'>
                  <button
                    className={`flex h-[30px] items-center justify-center px-2.5 transition-colors ${
                      viewMode === 'grid' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                    onClick={() => changeViewMode('grid')}
                    title='瀑布流视图（封面预览）'
                  >
                    {/* 2×2 小方块图标 */}
                    <svg width='15' height='15' viewBox='0 0 15 15' fill='currentColor'>
                      <rect x='1' y='1' width='5.5' height='5.5' rx='1' />
                      <rect x='8.5' y='1' width='5.5' height='5.5' rx='1' />
                      <rect x='1' y='8.5' width='5.5' height='5.5' rx='1' />
                      <rect x='8.5' y='8.5' width='5.5' height='5.5' rx='1' />
                    </svg>
                  </button>
                  <button
                    className={`flex h-[30px] items-center justify-center px-2.5 transition-colors ${
                      viewMode === 'list' ? 'bg-cyan-600 text-white' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                    onClick={() => changeViewMode('list')}
                    title='列表视图（含大小/修改时间，便于批量选择）'
                  >
                    {/* 三横杠图标 */}
                    <svg width='15' height='15' viewBox='0 0 15 15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round'>
                      <path d='M2 3.5h11' />
                      <path d='M2 7.5h11' />
                      <path d='M2 11.5h11' />
                    </svg>
                  </button>
                </div>
                {filters.folderId != null && (
                  <button
                    className='flex h-[30px] items-center rounded-lg border border-cyan-700 px-2.5 text-xs text-cyan-300 hover:bg-cyan-950 disabled:opacity-50'
                    disabled={scanning}
                    onClick={() => scan(filters.dirPath ? { folderId: filters.folderId, dirPath: filters.dirPath } : { folderId: filters.folderId })}
                    title={filters.dirPath ? '只扫描当前浏览的子目录' : '只扫描当前选中的文件夹'}
                  >
                    {scanning ? '扫描中…' : filters.dirPath ? '扫描此目录' : '扫描此文件夹'}
                  </button>
                )}
                </div>
              </div>
              {viewMode === 'grid' ? (
                <VideoGrid
                  cards={cards}
                  selectedIds={selectedIds}
                  onSelectionChange={setSelectedIds}
                  showDuration={showDuration}
                  showSize={showSize}
                  coverH={coverH}
                  onOpen={(v) => setOpenVideoId(v.id)}
                  onCardContextMenu={(e, v) => {
                    e.preventDefault()
                    setCardMenu({ x: e.clientX, y: e.clientY, video: v })
                  }}
                />
              ) : (
                <VideoTable
                  videos={rows}
                  selectedIds={selectedIds}
                  onSelectionChange={setSelectedIds}
                  onOpen={(v) => setOpenVideoId(v.id)}
                  onRowContextMenu={(e, v) => {
                    e.preventDefault()
                    setCardMenu({ x: e.clientX, y: e.clientY, video: v })
                  }}
                />
              )}
              {rows.length < total && (
                <div ref={sentinelRef} className='flex justify-center py-6'>
                  <span className='text-xs text-slate-500'>
                    {loadingMore ? '加载中…' : `${rows.length} / ${total}`}
                  </span>
                </div>
              )}
            </>
          )}
        </main>
      </div>

      {/* 框选后的批量操作栏 */}
      {selectedIds.size > 0 && (
        <div className='anim-fade-up fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-900/95 px-4 py-2.5 shadow-2xl shadow-black/60 backdrop-blur'>
          <div className='flex items-center gap-3'>
            <span className='text-sm text-slate-200'>
              已选择 <span className='font-semibold text-cyan-300'>{selectedIds.size}</span> 个视频
              {selectedTotalSize > 0 && (
                <span className='ml-1.5 text-xs text-slate-400'>
                  共 {formatSizeGB(selectedTotalSize)}
                </span>
              )}
            </span>
            <span className='text-xs text-slate-500'>
              （{viewMode === 'grid' ? 'Ctrl 点选切换 · Shift 点选区间 · 空白拖动框选' : 'Ctrl 点选切换 · Shift 点选区间 · Ctrl+A 全选 · 拖动框选'} · Esc 取消）
            </span>
            <button
              className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50'
              onClick={() => setShowBatchEdit(true)}
              disabled={batchDeleting}
            >
              批量编辑
            </button>
            <button
              className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50'
              onClick={moveSelectedToDir}
              disabled={batchDeleting}
              title='选择目标目录，把选中的全部视频移动过去'
            >
              移动到…
            </button>
            <button
              className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50'
              onClick={() => startCompress(rows.filter((v) => selectedIds.has(v.id)))}
              disabled={batchDeleting}
            >
              压缩所选
            </button>
            <button
              className='rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50'
              onClick={deleteSelected}
              disabled={batchDeleting}
            >
              {batchDeleting ? '删除中…' : '删除所选'}
            </button>
            <button
              className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50'
              onClick={() => setSelectedIds(new Set())}
              disabled={batchDeleting}
            >
              取消选择
            </button>
          </div>
        </div>
      )}

      {/* 后台压缩进度面板（压缩期间可继续浏览，固定右下角） */}
      {compress && (
        <div className='anim-fade-up fixed bottom-4 right-4 z-40 w-80 rounded-xl border border-slate-700 bg-slate-900/95 p-3 shadow-2xl shadow-black/60 backdrop-blur'>
          <div className='mb-1.5 flex items-center justify-between gap-2'>
            <span className='text-sm font-medium text-slate-200'>视频压缩中</span>
            <span className='text-xs text-slate-500'>
              {compress.total ? `${compress.current ?? 0}/${compress.total}` : ''}
            </span>
          </div>
          <div
            className='truncate text-xs text-slate-400'
            title={compress.filename}
          >
            {compress.filename}
          </div>
          <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800'>
            <div
              className='h-full rounded-full bg-gradient-to-r from-cyan-500 to-indigo-500 transition-all duration-300'
              style={{ width: `${Math.max(2, Math.min(100, compress.percent ?? 0))}%` }}
            />
          </div>
          <div className='mt-1.5 flex items-center justify-between text-xs text-slate-500'>
            <span>
              {compress.stage ?? '压缩中'}
              {compress.speed ? ` · ${compress.speed}` : ''}
              {compress.outSize ? ` · ${(compress.outSize / 1024 / 1024).toFixed(1)}MB` : ''}
            </span>
            <span>{Math.round(compress.percent ?? 0)}%</span>
          </div>

          {/* 剩余待压缩文件 */}
          {!!compress.remaining?.length && (
            <div className='mt-2 border-t border-slate-800 pt-2'>
              <button
                className='flex w-full items-center justify-between text-xs text-slate-400 hover:text-slate-200'
                onClick={() => setShowRemaining((v) => !v)}
              >
                <span>剩余 {compress.remaining.length} 个待压缩</span>
                <span>{showRemaining ? '收起 ▲' : '展开 ▼'}</span>
              </button>
              {showRemaining && (
                <div className='mt-1.5 max-h-40 space-y-0.5 overflow-y-auto'>
                  {compress.remaining.map((name, i) => (
                    <div
                      key={`${name}-${i}`}
                      className='truncate text-xs text-slate-500'
                      title={name}
                    >
                      {name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <button
            className='mt-2 w-full rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-800'
            onClick={() => window.api.cancelCompress()}
          >
            取消压缩（当前文件处理完后停止）
          </button>
        </div>
      )}

      {openVideoId !== null && (
        <VideoDetail
          videoId={openVideoId}
          onClose={() => setOpenVideoId(null)}
        />
      )}

      {/* 卡片右键菜单 */}
      {cardMenu && (
        <>
          <div className='fixed inset-0 z-50' onClick={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }} />
          <div
            className='anim-dialog fixed z-[51] w-48 overflow-hidden rounded-xl border border-slate-700 bg-slate-900/95 py-1 shadow-2xl shadow-black/60 backdrop-blur'
            style={{ left: Math.min(cardMenu.x, window.innerWidth - 200), top: Math.min(cardMenu.y, window.innerHeight - 150) }}
          >
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
              onClick={async () => {
                const v = cardMenu.video
                setCardMenu(null)
                const d = await window.api.getVideo(v.id)
                if (d) setEditVideo(d)
              }}
            >
              编辑视频信息
            </button>
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
              onClick={() => {
                const v = cardMenu.video
                setCardMenu(null)
                setCaptureVideo({ videoPath: v.path, videoId: v.id })
              }}
            >
              手动截取缩略图
            </button>
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
              onClick={() => {
                const v = cardMenu.video
                setCardMenu(null)
                startCompress([v])
              }}
            >
              压缩视频…
            </button>
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
              onClick={() => {
                const v = cardMenu.video
                setCardMenu(null)
                setRenameVideo({ videoId: v.id, filename: v.filename })
              }}
            >
              重命名文件…
            </button>
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
              onClick={() => {
                setCardMenu(null)
                window.api.showInFolder(cardMenu.video.path)
              }}
            >
              打开所在文件夹
            </button>
            <button
              className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
              onClick={async () => {
                const v = cardMenu.video
                setCardMenu(null)
                // 右键的视频在选中集内且为多选 → 集体移动；否则只移动该视频
                if (selectedIds.size > 1 && selectedIds.has(v.id)) {
                  await moveSelectedToDir()
                  return
                }
                const dir = await window.api.pickDirectory()
                if (!dir) return
                const r = await window.api.moveVideo({ id: v.id, targetDir: dir })
                if (!r.ok) {
                  flash(r.error ?? '移动失败')
                  return
                }
                if (r.moved === false) {
                  flash('该视频已在目标文件夹中')
                  return
                }
                flash(`已移动「${v.filename}」`)
                reloadMeta()
                reloadVideos(0)
              }}
            >
              {selectedIds.size > 1 && selectedIds.has(cardMenu.video.id)
                ? `移动 ${selectedIds.size} 个视频到…`
                : '移动视频到…'}
            </button>
            <div className='my-1 border-t border-slate-800' />
            <button
              className='block w-full px-4 py-2 text-left text-sm text-red-400 hover:bg-red-950/60'
              onClick={async () => {
                const v = cardMenu.video
                setCardMenu(null)
                const r = await window.api.deleteVideo(v.id)
                if (r.cancelled) return
                if (!r.ok) {
                  flash(r.error ?? '删除失败')
                  return
                }
                flash(r.partial ? `已删除（部分文件未删除干净：${r.failed?.join('；') ?? ''}）` : `已彻底删除「${v.filename}」`)
                reloadMeta()
                reloadVideos(0)
              }}
            >
              删除影片…
            </button>
          </div>
        </>
      )}

      {editVideo && (
        <VideoEditForm
          detail={editVideo}
          onClose={() => setEditVideo(null)}
          onSaved={() => {
            setEditVideo(null)
            reloadMeta()
            reloadVideos(0)
          }}
        />
      )}

      {captureVideo && (
        <CaptureDialog
          videoPath={captureVideo.videoPath}
          videoId={captureVideo.videoId}
          initialTime={0}
          onClose={() => setCaptureVideo(null)}
          onSaved={() => {
            setCaptureVideo(null)
            reloadMeta()
            reloadVideos(0)
          }}
        />
      )}

      {showBatchEdit && (
        <BatchEditDialog
          videoIds={selectedIds.size > 0 ? [...selectedIds] : rows.map((v) => v.id)}
          onClose={() => setShowBatchEdit(false)}
          onDone={reloadMeta}
        />
      )}

      {renameVideo && (
        <RenameDialog
          filename={renameVideo.filename}
          onClose={() => setRenameVideo(null)}
          onDone={async (newName) => {
            const r = await window.api.renameVideo({ id: renameVideo.videoId, newName })
            setRenameVideo(null)
            if (!r.ok) {
              flash(r.error ?? '重命名失败')
              return
            }
            if (r.renamed === false) {
              flash('文件名未变化')
              return
            }
            flash(`已重命名为「${r.filename}」`)
            reloadMeta()
            reloadVideos(0)
          }}
        />
      )}
    </div>
  )
}
