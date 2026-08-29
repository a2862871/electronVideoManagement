import { useCallback, useEffect, useRef, useState } from 'react'
import ActorPage from './components/ActorPage'
import BatchEditDialog from './components/BatchEditDialog'
import CaptureDialog from './components/CaptureDialog'
import RenameDialog from './components/RenameDialog'
import SettingsPage from './components/SettingsPage'
import Sidebar, { type Filters } from './components/Sidebar'
import TagPage from './components/TagPage'
import VideoDetail from './components/VideoDetail'
import VideoEditForm from './components/VideoEditForm'
import VideoGrid, { groupByWork } from './components/VideoGrid'
import type { ActorDto, TagDto, VideoDetailDto, VideoDto, WatchFolderDto } from './type/library'

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

  const hasApi = typeof window.api !== 'undefined'
  const mainRef = useRef<HTMLElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)

  const reloadMeta = useCallback(async () => {
    const [f, t, a] = await Promise.all([window.api.listFolders(), window.api.listTags(), window.api.listActors()])
    setFolders(f)
    setTags(t)
    setActors(a)
  }, [])

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

  // 拖拽视频卡片到目录树释放：整组移动到目标目录（须在同一主目录范围内）
  async function moveVideosToDir(payload: { ids: number[]; folderId: number }, dirPath: string) {
    const owner = folders.find((f) => f.id === payload.folderId)
    if (owner && !dirPath.startsWith(owner.path)) {
      flash('只能在同一主目录范围内移动（跨目录请用右键「移动视频到…」）')
      return
    }
    let moved = 0
    let same = 0
    const errors: string[] = []
    for (const id of payload.ids) {
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
    if (errors.length > 0) parts.push(`失败 ${errors.length}（${errors[0].slice(0, 60)}${errors.length > 1 ? '…' : ''}）`)
    flash(parts.join('，') || '未发生移动')
    reloadMeta()
    reloadVideos(0)
  }

  async function batchThumbs() {
    if (rows.length === 0) return
    setThumbing(true)
    setThumbProgress({ done: 0, total: rows.length, current: '' })
    const off = window.api.onBatchThumbProgress((p) => setThumbProgress(p))
    const r = await window.api.batchGrabThumbs(rows.map((v) => ({ id: v.id, path: v.path })))
    off()
    setThumbing(false)
    setThumbProgress(null)
    if (r.cancelled) return
    const skipMsg = r.skipped > 0 ? `，跳过已有缩略图 ${r.skipped} 个` : ''
    if (r.failed.length === 0) {
      flash(`已为 ${r.ok} 个视频生成缩略图${skipMsg}`)
    } else {
      const names = r.failed.slice(0, 3).map((f) => f.path.split(/[\\/]/).pop()).join('、')
      flash(`生成成功 ${r.ok} 个，失败 ${r.failed.length} 个${skipMsg}（如：${names}${r.failed.length > 3 ? '…' : ''}）`)
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

  const cards = groupByWork(rows)

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
          {filters.folderId != null && (
            <button
              className='rounded-lg border border-cyan-700 px-3 py-1.5 text-sm text-cyan-300 hover:bg-cyan-950 disabled:opacity-50'
              disabled={scanning}
              onClick={() => scan(filters.dirPath ? { folderId: filters.folderId, dirPath: filters.dirPath } : { folderId: filters.folderId })}
              title={filters.dirPath ? '只扫描当前浏览的子目录' : '只扫描当前选中的文件夹'}
            >
              {scanning ? '扫描中…' : filters.dirPath ? '扫描此目录' : '扫描此文件夹'}
            </button>
          )}
          <button
            className='rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900 disabled:opacity-50'
            disabled={thumbing || rows.length === 0}
            onClick={batchThumbs}
            title='对当前列表中的全部视频从中间位置抽帧生成缩略图'
          >
            {thumbing ? `生成中 ${thumbProgress?.done ?? 0}/${thumbProgress?.total ?? rows.length}…` : '一键缩略图'}
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
              {!search && (filters.tagIds?.length || filters.dirPath || filters.actorId) && (
                <div className='flex flex-wrap items-center gap-2 px-4 pt-3'>
                  {filters.dirPath && (
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
                  {filters.actorId && (
                    <span className='inline-flex items-center gap-2 rounded-full bg-cyan-900/60 px-3 py-1 text-xs text-cyan-300'>
                      演员：{actors.find((a) => a.id === filters.actorId)?.name ?? filters.actorId}
                      <button className='text-cyan-200 hover:text-white' onClick={() => setFilters((f) => ({ ...f, actorId: undefined }))}>
                        ✕
                      </button>
                    </span>
                  )}
                  {filters.tagIds?.map((tagId) => (
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
              )}
              <VideoGrid
                cards={cards}
                onOpen={(v) => setOpenVideoId(v.id)}
                onCardContextMenu={(e, v) => {
                  e.preventDefault()
                  setCardMenu({ x: e.clientX, y: e.clientY, video: v })
                }}
              />
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
              移动视频到…
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
          videoIds={rows.map((v) => v.id)}
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
