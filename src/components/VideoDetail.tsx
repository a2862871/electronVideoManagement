import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDialog } from './DialogProvider'
import PlaylistPanel from './PlaylistPanel'
import type { PlaylistItemDto, PlaylistPageDto, VideoDetailDto, VideoQuery } from '../type/library'
import { mediaUrl } from '../utils/media'

/** 播放列表范围：当前文件夹 / 演员（或标签、搜索）范围内的全部视频 */
export interface PlaylistScope {
  /** 范围说明，显示在播放列表头部（如「演员：xxx」「目录：xxx」） */
  title: string
  /** 查询条件（与列表页一致，不含分页） */
  query: VideoQuery
}

interface Props {
  videoId: number
  /** 播放列表范围；为空则不显示播放列表 */
  playlist?: PlaylistScope | null
  /** 在播放列表内切换视频（由父组件更新 videoId，保证「当前视频」只有一个来源） */
  onOpenVideo?(id: number): void
  onClose(): void
}

/** 播放列表栏宽度（与 PlaylistPanel 的 w-[320px] 保持一致，用于计算窗口尺寸） */
const LIST_W = 320
/** 播放列表栏与视频区之间的间距（外层 gap-3） */
const LIST_GAP = 12

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

export default function VideoDetail({ videoId, playlist, onOpenVideo, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const infoRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<VideoDetailDto | null>(null)
  const [playerError, setPlayerError] = useState('')
  // 对话框尺寸：按视频真实分辨率自适应（loadedmetadata 时计算）
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  // 画面旋转（90° 步进：0/90/180/270）：只在播放器黑色区域内旋转画面本身，
  // 对话框与信息区保持不动（不随旋转换向）。
  const [rotation, setRotation] = useState(0)
  // 旋转角度的 ref 副本：fitBox 读取它而不产生依赖（避免旋转时窗口形态跳变）
  const rotationRef = useRef(0)
  // 旋转 90/270 时画面等比缩放系数：旋转后包围盒恰好放进播放区域
  const [rotScale, setRotScale] = useState(1)
  const playerRef = useRef<HTMLDivElement>(null)
  const { alert } = useDialog()

  // ---------- 播放列表（当前文件夹/演员范围内的全部视频） ----------
  const [list, setList] = useState<PlaylistItemDto[]>([])
  const [listTotal, setListTotal] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  // 播放列表是否展开（记忆到 settings，默认展开）
  const [listOpen, setListOpen] = useState(true)
  // 播放结束后自动播放下一个（记忆到 settings，默认开启）
  const [autoNext, setAutoNext] = useState(true)
  // 占满窗口：对话框铺满整个窗口（不再按视频比例收窄）。
  // 该模式下播放列表照常显示在右侧（有列表就不隐藏），视频占满剩余空间。
  const [fill, setFill] = useState(false)
  const fillRef = useRef(false)
  // 播放列表内切换视频后需要自动起播（用户点击列表项/上一个/下一个时置位）
  const autoPlayRef = useRef(false)
  const showPanel = listOpen && !!playlist
  // fitBox 读取的展开状态快照（避免把 listOpen 写进 fitBox 依赖导致重复绑定 resize）
  const showPanelRef = useRef(showPanel)

  // 依视频纵横比在可用空间（96vw/92vh 扣除信息区、播放列表栏）内计算对话框大小。
  // 打开播放器时按「已保存旋转角度」的方向适配窗口（旋转过 90° 的竖画面直接开竖窗）；
  // 用户点击旋转按钮时不重算窗口（画面在黑框内旋转缩放，窗口形态稳定）。
  const fitBox = useCallback(() => {
    // 占满窗口模式：尺寸交给 CSS（h-screen/w-screen），不再按视频比例算
    if (fillRef.current) {
      setBox(null)
      return
    }
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return
    const rot = rotationRef.current
    const r = rot === 90 || rot === 270 ? v.videoHeight / v.videoWidth : v.videoWidth / v.videoHeight
    const PAD = 32 // 对话框 p-4 四周内边距
    const GAP = 12 // flex flex-col gap-3 的上下间距
    const BTN_BAR = 42 // 底部按钮栏（约 30px）+ 间距
    const listW = showPanelRef.current ? LIST_W + LIST_GAP : 0
    const infoH = infoRef.current?.offsetHeight ?? 96
    const availW = window.innerWidth * 0.96 - PAD - listW
    const availH = window.innerHeight * 0.92 - PAD - GAP - infoH - BTN_BAR
    let h = availH
    let w = h * r
    if (w > availW) {
      w = availW
      h = w / r
    }
    // 温和下限：避免竖屏/超宽视频把对话框压得过窄过扁
    w = Math.max(w, 420)
    h = Math.max(h, 260)
    setBox({ w: Math.round(w) + PAD + listW, h: Math.round(h) + PAD + GAP + infoH + BTN_BAR })
  }, [])

  useEffect(() => {
    window.addEventListener('resize', fitBox)
    return () => window.removeEventListener('resize', fitBox)
  }, [fitBox])

  // 播放列表展开/收起、占满窗口切换后可用空间变化：
  // 重算对话框尺寸（DOM 已提交，信息区高度也是新布局下的值）
  useEffect(() => {
    showPanelRef.current = showPanel
    fillRef.current = fill
    fitBox()
  }, [showPanel, fill, fitBox])

  // 读取播放器记忆项（播放列表展开状态、自动连播开关、占满窗口）
  useEffect(() => {
    window.api.getSetting('playerPlaylistOpen').then((v) => setListOpen(v !== '0'))
    window.api.getSetting('playerAutoNext').then((v) => setAutoNext(v !== '0'))
    window.api.getSetting('playerFillWindow').then((v) => setFill(v === '1'))
  }, [])

  // 载入播放列表：范围（playlist）在打开播放器时由父组件冻结，播放过程中保持稳定
  useEffect(() => {
    if (!playlist) {
      setList([])
      setListTotal(0)
      return
    }
    let disposed = false
    setListLoading(true)
    setListError('')
    const q = playlist.query
    // 兼容：主进程/preload 未随新代码重启时没有 getPlaylist 通道，退化为普通分页查询
    // （VideoDto 字段是 PlaylistItemDto 的超集，可直接用作列表项），重启后自动走新接口
    const req: Promise<PlaylistPageDto> =
      typeof window.api.getPlaylist === 'function'
        ? window.api.getPlaylist(q)
        : window.api.queryVideos({ ...q, limit: 2000 }).then((r) => ({ total: r.total, rows: r.rows }))
    req
      .then((p) => {
        if (disposed) return
        setList(p.rows)
        setListTotal(p.total)
      })
      .catch((e: unknown) => {
        if (!disposed) setListError(`播放列表加载失败：${e instanceof Error ? e.message : String(e)}`)
      })
      .finally(() => {
        if (!disposed) setListLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [playlist])

  const curIdx = useMemo(() => list.findIndex((v) => v.id === videoId), [list, videoId])
  const prevItem = curIdx > 0 ? list[curIdx - 1] : undefined
  const nextItem = curIdx >= 0 && curIdx < list.length - 1 ? list[curIdx + 1] : undefined

  // 切换播放列表中的某个视频（父组件更新 videoId → 下方 effect 重新拉取详情并换源）。
  // 依赖保持稳定：播放列表条目已 memo 化，回调变化会连带重渲染整个列表。
  const playListItem = useCallback(
    (id: number) => {
      autoPlayRef.current = true
      onOpenVideo?.(id)
    },
    [onOpenVideo],
  )

  // 展开/收起播放列表（记忆到 settings）
  const toggleList = useCallback(() => {
    const next = !listOpen
    setListOpen(next)
    window.api.setSetting({ key: 'playerPlaylistOpen', value: next ? '1' : '0' })
  }, [listOpen])

  const toggleAutoNext = useCallback(() => {
    const next = !autoNext
    setAutoNext(next)
    window.api.setSetting({ key: 'playerAutoNext', value: next ? '1' : '0' })
  }, [autoNext])

  // 占满窗口（记忆到 settings）：对话框铺满整个窗口，视频占满剩余空间；
  // 播放列表不受影响（有列表就继续显示在右侧，不隐藏）
  const toggleFill = useCallback(() => {
    const next = !fill
    setFill(next)
    window.api.setSetting({ key: 'playerFillWindow', value: next ? '1' : '0' })
  }, [fill])

  // 旋转 90/270 时：视频元素布局尺寸不变（未旋转的等比适配），
  // 用 scale 把旋转后的包围盒缩放到恰好填满播放区域，画面只在黑框内转。
  const updateRotScale = useCallback(() => {
    const v = videoRef.current
    const c = playerRef.current
    if (!v || !c || !v.videoWidth || !v.videoHeight) return
    if (rotation === 90 || rotation === 270) {
      const cw = c.clientWidth
      const ch = c.clientHeight
      const nw = v.videoWidth
      const nh = v.videoHeight
      const k = Math.min(cw / nw, ch / nh) // 未旋转 contain 适配系数
      setRotScale(Math.min(cw / (nh * k), ch / (nw * k)))
    } else {
      setRotScale(1)
    }
  }, [rotation])

  // 旋转角度 / 元数据 / 对话框尺寸变化后重算缩放（box 就绪意味着容器尺寸已定）
  useEffect(() => {
    updateRotScale()
  }, [updateRotScale, detail, box])

  // 占满窗口模式下对话框尺寸由 CSS 撑满，窗口缩放不会改变 box：
  // 单独监听 resize 重算旋转缩放，避免旋转后缩放比例停留在旧尺寸上
  useEffect(() => {
    const onResize = () => updateRotScale()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updateRotScale])

  // 旋转 90° 并持久化到数据库（下次打开自动应用）
  const rotateVideo = useCallback(() => {
    setRotation((r) => {
      const next = (r + 90) % 360
      rotationRef.current = next
      window.api.setVideoRotation({ id: videoId, rotation: next })
      return next
    })
  }, [videoId])

  // 快捷键：R 旋转 90°，P/上一个、N/下一个切换列表视频，L 显示/隐藏播放列表，F 占满窗口
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase()
      if (k === 'r') rotateVideo()
      else if (k === 'n' && nextItem) playListItem(nextItem.id)
      else if (k === 'p' && prevItem) playListItem(prevItem.id)
      else if (k === 'l' && playlist) toggleList()
      else if (k === 'f') toggleFill()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rotateVideo, playListItem, nextItem, prevItem, playlist, toggleList, toggleFill])

  // 续播位置：getVideo 异步返回后暂存，onLoadedMetadata 时应用到 video
  // （video 元素在 detail 渲染后才存在，effect 里同步读 ref 是 null，必须延迟到渲染后）
  const resumePosRef = useRef(0)
  useEffect(() => {
    let disposed = false
    setPlayerError('')
    window.api.getVideo(videoId).then((d) => {
      if (!d || disposed) return
      resumePosRef.current = d.play_position_sec || 0
      rotationRef.current = ((d.rotation ?? 0) % 360 + 360) % 360
      setRotation(rotationRef.current)
      setDetail(d)
      // 若 metadata 先于此回调就绪，fitBox 已按 rotation=0 计算过 → 现在按已存角度重算窗口方向
      fitBox()
    })
    return () => {
      disposed = true
      // 卸载兜底：组件销毁时保存当前音量（volumechange 已实时保存，此处防漏）
      const v = videoRef.current
      if (v) window.api.setSetting({ key: 'playerVolume', value: String(v.volume) })
    }
  }, [videoId])

  // 视频元数据就绪：恢复播放位置 + 应用记忆音量（默认 10%）+ 列表内切换后自动起播。
  // 放在这里而非 getVideo 回调，因为此时 video 元素才真正挂载、ref 可用。
  function handleMetadata(e: React.SyntheticEvent<HTMLVideoElement>) {
    fitBox()
    const v = e.currentTarget
    const pos = resumePosRef.current
    if (pos > 0) v.currentTime = pos
    window.api.getSetting('playerVolume').then((vol) => {
      const n = vol != null ? Number(vol) : NaN
      v.volume = Number.isFinite(n) && n >= 0 && n <= 1 ? n : 0.1
    })
    if (autoPlayRef.current) {
      autoPlayRef.current = false
      // 由用户点击列表触发，手势允许起播；失败（如编码不支持）时不打断，交给 onError 提示
      void v.play().catch(() => {})
    }
  }

  if (!detail) return null

  const src = mediaUrl(detail.path)

  const bitrate =
    detail.size_bytes && detail.runtime
      ? `${((detail.size_bytes * 8) / 1_000_000 / detail.runtime).toFixed(1)} Mbps`
      : null

  const meta = [
    ['番号', detail.num],
    ['分集', detail.part],
    ['原名', detail.originaltitle],
    ['演员', detail.actors.join('、')],
    ['标签', detail.tags.join('、')],
    ['片商', detail.studio],
    ['系列', detail.series],
    ['发行日期', detail.releasedate],
    ['评分', detail.rating != null ? String(detail.rating) : null],
    ['时长', detail.runtime != null ? `${detail.runtime} 分钟` : null],
    ['大小', detail.size_bytes != null ? formatSize(detail.size_bytes) : null],
    ['码率', bitrate],
  ].filter(([, v]) => v) as [string, string][]

  const btnCls =
    'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent'

  return (
    <div
      className={`fixed inset-0 z-40 flex items-center justify-center bg-black/80 ${fill ? 'p-0' : 'p-4'}`}
      onClick={onClose}
    >
      <div
        className={`anim-dialog flex gap-3 overflow-hidden bg-slate-950 p-4 ${
          fill
            ? 'h-screen w-screen'
            : 'h-[min(1000px,92vh)] w-[min(1920px,96vw)] rounded-2xl border border-slate-700 shadow-2xl shadow-black/60'
        }`}
        style={!fill && box ? { width: box.w, height: box.h } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧：信息 + 播放器 + 按钮栏 */}
        <div className='flex min-h-0 min-w-0 flex-1 flex-col gap-3'>
          {/* 上方：文字信息 */}
          <div ref={infoRef} className='shrink-0 space-y-2'>
            <div className='flex items-center gap-3'>
              <h2 className='min-w-0 flex-1 truncate text-lg font-semibold text-slate-100'>{detail.title ?? detail.filename}</h2>
              <button
                className='shrink-0 rounded-lg px-2 py-1 text-base leading-none text-slate-500 transition-colors hover:bg-slate-800 hover:text-slate-200'
                title='关闭'
                onClick={onClose}
              >
                ✕
              </button>
            </div>
            <div className='flex flex-wrap gap-x-5 gap-y-1 text-sm'>
              {meta.map(([k, v]) => (
                <span key={k} className='min-w-0'>
                  <span className='text-slate-500'>{k}：</span>
                  <span className='text-slate-200'>{v}</span>
                </span>
              ))}
            </div>
            {detail.plot && <div className='max-h-16 overflow-y-auto text-sm leading-relaxed text-slate-400'>{detail.plot}</div>}
          </div>

          {/* 下方：播放器（原生控件：进度条/播放/音量/全屏，点击画面播放暂停） */}
          <div
            ref={playerRef}
            className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black ${fill ? '' : 'rounded-lg'}`}
          >
            <video
              ref={videoRef}
              src={src ?? undefined}
              controls
              // 占满窗口时用 object-contain 撑满可用区域（小分辨率视频也会放大），
              // 旋转缩放的计算也依赖「画面 = 容器等比缩小」这一前提
              className={fill ? 'h-full w-full object-contain' : 'max-h-full max-w-full'}
              style={{
                transform: rotation ? `rotate(${rotation}deg) scale(${rotScale})` : undefined,
              }}
              onLoadedMetadata={handleMetadata}
              onVolumeChange={(e) => {
                // 实时记忆音量（拖动音量条/静音切换都会触发）
                const v = e.currentTarget.volume
                window.api.setSetting({ key: 'playerVolume', value: String(v) })
              }}
              onEnded={() => {
                // 连播：播放结束自动切到列表中的下一个
                if (autoNext && nextItem) playListItem(nextItem.id)
              }}
              onError={(e) => {
                const err = e.currentTarget.error
                const codeMap: Record<number, string> = {
                  1: '已中止', 2: '网络错误', 3: '解码失败（编码不支持）', 4: '源不支持',
                }
                const code = err?.code
                const msg = err?.message
                setPlayerError(`无法加载视频${code ? `（code=${code} ${codeMap[code] ?? ''}${msg ? '：' + msg : ''}）` : ''}`)
              }}
            />
            {playerError && (
              <div className='absolute bottom-12 left-1/2 -translate-x-1/2 rounded bg-red-900/90 px-3 py-1.5 text-xs text-red-100'>
                {playerError}
              </div>
            )}
          </div>

          {/* 底部按钮栏：独立于播放区域，不遮挡原生进度条 */}
          <div className='flex shrink-0 items-center justify-between gap-2'>
            <div className='flex items-center gap-2'>
              {playlist && (
                <>
                  <button
                    className={btnCls}
                    disabled={!prevItem}
                    title={prevItem ? `上一个：${prevItem.filename}（快捷键 P）` : '已经是第一个'}
                    onClick={() => prevItem && playListItem(prevItem.id)}
                  >
                    上一个
                  </button>
                  <button
                    className={btnCls}
                    disabled={!nextItem}
                    title={nextItem ? `下一个：${nextItem.filename}（快捷键 N）` : '已经是最后一个'}
                    onClick={() => nextItem && playListItem(nextItem.id)}
                  >
                    下一个
                  </button>
                  {curIdx >= 0 && (
                    <span className='text-xs text-slate-500'>
                      {curIdx + 1} / {list.length}
                      {list.length < listTotal ? `（共 ${listTotal}）` : ''}
                    </span>
                  )}
                </>
              )}
            </div>
            <div className='flex items-center gap-2'>
              <button
                className={btnCls}
                title='旋转画面 90°（快捷键 R），角度会保存，下次打开自动应用'
                onClick={rotateVideo}
              >
                ⟳ 旋转 {rotation}°
              </button>
              {/* 占满窗口 / 播放列表：放在「外部播放器」左边 */}
              <button
                className={`${btnCls} font-medium ${fill ? 'border-cyan-600 bg-cyan-600/20 text-cyan-300' : ''}`}
                title={
                  fill
                    ? '退出占满窗口，恢复按视频比例自适应大小（快捷键 F）'
                    : '占满整个窗口（快捷键 F）：视频铺满窗口，播放列表有内容就继续显示在右侧'
                }
                onClick={toggleFill}
              >
                ⛶ 占满窗口
              </button>
              {playlist && (
                <button
                  className={`${btnCls} font-medium ${listOpen ? 'border-cyan-600 bg-cyan-600/20 text-cyan-300' : ''}`}
                  title='显示/隐藏右侧播放列表：当前文件夹/演员范围内的全部视频（快捷键 L）'
                  onClick={toggleList}
                >
                  ☰ 播放列表{list.length > 0 ? ` ${list.length}` : ''}
                </button>
              )}
              <button
                className={btnCls}
                title='用设置中配置的外部播放器打开'
                onClick={async () => {
                  const err = await window.api.openInPlayer(detail.path)
                  if (err) await alert({ title: '播放失败', message: err, danger: true })
                }}
              >
                外部播放器
              </button>
            </div>
          </div>
        </div>

        {/* 右侧：播放列表（当前文件夹/演员等范围内的全部视频） */}
        {showPanel && playlist && (
          <PlaylistPanel
            title={playlist.title}
            items={list}
            total={listTotal}
            loading={listLoading}
            error={listError}
            currentId={videoId}
            autoNext={autoNext}
            onToggleAutoNext={toggleAutoNext}
            onPick={playListItem}
          />
        )}
      </div>
    </div>
  )
}
