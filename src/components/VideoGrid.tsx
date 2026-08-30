import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VideoDto } from '../type/library'
import { coverOf, formatDuration, formatSizeGB } from '../utils/media'

/** 卡片拖拽数据的 MIME 类型（Sidebar 目录节点按此识别投放） */
export const VIDEO_DND_MIME = 'application/x-videolib-video'

export interface WorkCard {
  key: string
  num: string | null
  title: string | null
  subDir: string | null
  videos: VideoDto[]
}

export function groupByWork(rows: VideoDto[]): WorkCard[] {
  const map = new Map<string, WorkCard>()
  for (const v of rows) {
    const key = v.num ? `${v.folder_id}|${v.sub_dir ?? ''}|${v.num.toLowerCase()}` : `video|${v.id}`
    let card = map.get(key)
    if (!card) {
      card = { key, num: v.num, title: v.title, subDir: v.sub_dir, videos: [] }
      map.set(key, card)
    }
    if (!card.title && v.title) card.title = v.title
    card.videos.push(v)
  }
  return [...map.values()]
}

// 瀑布流布局（CSS 多列）：所有卡片同宽=列宽，卡片紧密堆叠无行盒空隙。
// coverH 语义：横版封面（16:9）的高度基准，据此推导列宽 = coverH × 16/9。
// 卡片宽度统一为列宽，封面高度 = 列宽 ÷ 图片比例（保持真实比例，竖图自然更高更大），
// 仅对极端超长海报做高度上限钳制，避免卡片过高。
export const DEFAULT_COVER_H = 309
/** 封面基准高度可调范围（px） */
export const MIN_COVER_H = 150
export const MAX_COVER_H = 420
// 封面最大高度 = coverH × 该系数（自动跟随配置）；超出则轻微裁剪（object-cover）
export const PORTRAIT_SCALE = 2.6
const DEFAULT_RATIO = 2 / 3
const LANDSCAPE_RATIO = 16 / 9
// 竖图宽度下限比例（对应高度上限），避免极端超长海报把卡片撑得过高
const MIN_PORTRAIT_RATIO = 0.5
// 横图宽度上限比例，避免极端超宽图把卡片撑得过宽（覆盖到 2.39:1 宽银幕）
const MAX_LANDSCAPE_RATIO = 2.5

/** 由封面基准高度推导列宽（横图 16:9 时的宽度）。 */
export function columnWidth(coverH: number): number {
  return Math.round(coverH * LANDSCAPE_RATIO)
}


function useCoverRatio(src: string | null, onResolved?: (ratio: number) => void) {
  const [ratio, setRatio] = useState<number>(DEFAULT_RATIO)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setRatio(DEFAULT_RATIO)
    setFailed(false)
    if (!src) return
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        const r = img.naturalWidth / img.naturalHeight
        setRatio(r)
        onResolved?.(r)
      }
    }
    img.onerror = () => setFailed(true)
    img.src = src
    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [src, onResolved])

  return { ratio, failed, setFailed }
}

/** 封面高度：按列宽与图片比例计算（宽 = 列宽），上限 coverH × PORTRAIT_SCALE。 */
export function coverHeightOf(ratio: number, colW: number, coverH: number): number {
  const r = Math.min(Math.max(ratio, MIN_PORTRAIT_RATIO), MAX_LANDSCAPE_RATIO)
  return Math.round(Math.min(colW / r, coverH * PORTRAIT_SCALE))
}

/**
 * 卡片预估高度（封面 + 信息区），用于瀑布流分列。
 * 列内是正常文档流，因此估算偏差只影响"哪一列最矮"的选择，不会造成重叠或错乱。
 */
function estimateCardHeight(ratio: number, colW: number, coverH: number, card: WorkCard): number {
  const cover = coverHeightOf(ratio, colW, coverH)
  // 信息区：p-2.5 上下 20px + 标题两行 40px + 底部间距 16px + 集数/子目录行（若有）
  let info = 20 + 40 + 16
  if (card.videos.length > 1) info += 24 // 集数徽章行
  if (card.videos[0].sub_dir) info += 20 // 子目录行
  return cover + info
}

interface CardProps {
  card: WorkCard
  /** 该卡片内是否已全选（用于选中态描边） */
  selected: boolean
  /** 是否在封面右下角显示视频时长 */
  showDuration: boolean
  /** 是否在封面右下角（时长左侧）显示文件大小 */
  showSize: boolean
  /** 封面基准高度（横图高度，竖图按比例放大） */
  coverH: number
  /** 列宽（所有卡片等宽） */
  colW: number
  /** 是否处于多选模式（按住 Ctrl/Shift 时） */
  multiSelectMode: boolean
  /** 上报封面真实比例，供父组件分列估算高度（稳定后不再变化） */
  onRatioResolved?(ratio: number): void
  onOpen(video: VideoDto): void
  onCardContextMenu?(e: React.MouseEvent, video: VideoDto): void
}

function CardInner({ card, selected, showDuration, showSize, coverH, colW, multiSelectMode, onRatioResolved, onOpen, onCardContextMenu, index }: CardProps & { index: number }) {
  const src = coverOf(card.videos[0])
  // 内存 BLOB 缩略图（thumbcache://）已常驻主进程内存，直接同步加载并解码，
  // 不用 lazy——否则上滚时新进入视口的图才发起请求，会出现约 0.5s 的黑块。
  // NFO 磁盘图有真实 IO，仍走 lazy 以节省资源。
  const isMemoryThumb = src?.startsWith('thumbcache://') ?? false
  // 稳定回调：避免内联箭头导致 memo 失效
  const handleRatio = useCallback((r: number) => onRatioResolved?.(r), [onRatioResolved])
  // 时长：多集作品显示总时长，单集显示自身时长
  const totalMin = card.videos.reduce((sum, v) => sum + (v.runtime ?? 0), 0)
  const durationText = showDuration ? formatDuration(totalMin || null) : ''
  // 大小：多集作品显示合计大小
  const totalBytes = card.videos.reduce((sum, v) => sum + (v.size_bytes ?? 0), 0)
  const sizeText = showSize ? formatSizeGB(totalBytes || null) : ''
  const { ratio, failed, setFailed } = useCoverRatio(src, handleRatio)
  const real = failed || !src ? LANDSCAPE_RATIO : ratio
  // 宽度=列宽，高度按真实比例推导（极端比例由 coverHeightOf 内部钳制）
  const height = coverHeightOf(real, colW, coverH)

  return (
    <button
      className={`anim-fade-up group w-full overflow-hidden rounded-xl border bg-slate-900 text-left shadow-lg shadow-black/30 transition-all duration-200 hover:border-cyan-500/70 hover:shadow-[0_10px_32px_-8px_rgba(34,211,238,0.35)] ${
        multiSelectMode
          ? 'cursor-pointer hover:-translate-y-1' // 多选模式：指针光标，点击=选择
          : 'cursor-grab hover:-translate-y-1 active:cursor-grabbing' // 常态：抓手光标，拖动=移动文件
      } ${selected ? 'border-cyan-400 ring-2 ring-cyan-400/60' : 'border-slate-800'}`}
      style={{ maxWidth: colW, animationDelay: `${Math.min(index * 35, 420)}ms` }}
      data-card
      data-key={card.key}
      data-vids={card.videos.map((v) => v.id).join(',')}
      draggable
      onDragStart={(e) => {
        // 携带整组视频（同番号多集一起移动）与所属主目录，供目录树投放校验
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(
          VIDEO_DND_MIME,
          JSON.stringify({ ids: card.videos.map((v) => v.id), folderId: card.videos[0].folder_id }),
        )
      }}
      onClick={() => onOpen(card.videos[0])}
      onContextMenu={(e) => {
        e.preventDefault()
        onCardContextMenu?.(e, card.videos[0])
      }}
    >
      <div className='relative w-full overflow-hidden bg-slate-800' style={{ height }}>
        {/* 选中角标 */}
        {selected && (
          <span className='absolute right-2 top-2 z-10 flex h-5 w-5 items-center justify-center rounded-md bg-cyan-500 text-xs font-bold text-slate-950 shadow'>
            ✓
          </span>
        )}
        {src && !failed ? (
          <img
            src={src}
            // 内存缩略图立即加载（避免上滚黑块）；磁盘图懒加载
            loading={isMemoryThumb ? 'eager' : 'lazy'}
            // 同步解码：上滚时立刻上屏，避免异步解码带来的短暂空白
            decoding='sync'
            draggable={false}
            className='h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.05]'
            alt=''
            onError={() => setFailed(true)}
          />
        ) : (
          <div className='flex h-full w-full items-center justify-center text-3xl text-slate-600'>▶</div>
        )}
        {/* 角标叠图：集数 */}
        {card.videos.length > 1 && (
          <span className='absolute left-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-cyan-200 backdrop-blur-sm'>
            {card.videos.length} 集
          </span>
        )}
        {/* 角标叠图：大小 + 时长（右下角，同一容器内并排，避免重叠） */}
        {(sizeText || durationText) && (
          <span className='absolute bottom-2 right-2 flex items-center gap-1 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-slate-100 backdrop-blur-sm'>
            {sizeText && <span>{sizeText}</span>}
            {sizeText && durationText && <span className='opacity-40'>·</span>}
            {durationText && <span>{durationText}</span>}
          </span>
        )}
        {/* 底部渐变遮罩，突出 hover 质感 */}
        <div className='pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/60 to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100' />
      </div>
      <div className='space-y-1 p-2.5'>
        {card.num && (
          <span className='inline-block rounded-md bg-gradient-to-r from-cyan-600/80 to-indigo-600/80 px-1.5 py-0.5 text-xs font-mono font-medium text-cyan-50'>
            {card.num}
          </span>
        )}
        <div className='line-clamp-2 min-h-[2.5rem] text-sm text-slate-200'>
          {card.title ?? card.videos[0].filename}
        </div>
        {card.subDir && <div className='truncate text-xs text-slate-500'>{card.subDir}</div>}
      </div>
    </button>
  )
}

/**
 * memo 化卡片：滚动追加时只有新卡片会渲染，已有卡片 props 不变则跳过，
 * 避免 N 个组件无谓重渲染造成的闪烁。
 */
const Card = memo(CardInner)

interface Props {
  cards: WorkCard[]
  /** 当前选中的视频 id 集合 */
  selectedIds: Set<number>
  onSelectionChange(ids: Set<number>): void
  /** 是否在封面右下角显示视频时长（设置项） */
  showDuration: boolean
  /** 是否在封面右下角显示文件大小（设置项） */
  showSize: boolean
  /** 封面基准高度（横图高度，设置项） */
  coverH: number
  onOpen(video: VideoDto): void
  onCardContextMenu?(e: React.MouseEvent, video: VideoDto): void
}

/**
 * 框选：从卡片网格的**空白区域**按住拖动拉出矩形，框住的卡片全部选中。
 * 卡片上按下不启动框选（保留点击打开、拖拽移动文件到目录的既有行为）。
 * 按住 Ctrl 拖动 = 追加选择；点空白或按 Esc = 清空选择。
 */
// 瀑布流布局参数
const COL_GAP = 16
const ROW_GAP = 16

/**
 * JS 贪心分列瀑布流：每张卡片放进当前累计高度最矮的列。
 *
 * 关键点（解决 CSS 多列在无限滚动下的跳动问题）：
 * 1. 卡片归属一旦确定即**固化**（assignRef），后续追加/图片加载都不会让已有卡片跨列移动
 * 2. 列高每次从头重算，保证删除卡片后列高依然准确
 * 3. 列数变化（窗口缩放）时才重新分配
 */
function useWaterfallLayout(
  cards: WorkCard[],
  columns: number,
  colW: number,
  coverH: number,
  ratios: Map<string, number>,
): WorkCard[][] {
  // 卡片 key → 列索引（固化，保证追加时已有卡片不跳动）
  const assignRef = useRef(new Map<string, number>())
  const prevColumnsRef = useRef(columns)

  return useMemo(() => {
    // 列数变化 → 重新分配
    if (prevColumnsRef.current !== columns) {
      assignRef.current.clear()
      prevColumnsRef.current = columns
    }
    // 清理已删除的卡片，避免 Map 无限增长
    const alive = new Set(cards.map((c) => c.key))
    for (const k of [...assignRef.current.keys()]) {
      if (!alive.has(k)) assignRef.current.delete(k)
    }

    const cols: WorkCard[][] = Array.from({ length: columns }, () => [])
    const heights = new Array<number>(columns).fill(0)

    for (const card of cards) {
      let ci = assignRef.current.get(card.key)
      if (ci === undefined || ci >= columns) {
        // 新卡片：放入当前最矮的列
        let best = 0
        for (let i = 1; i < columns; i++) if (heights[i] < heights[best]) best = i
        ci = best
        assignRef.current.set(card.key, ci)
      }
      cols[ci].push(card)
      heights[ci] += estimateCardHeight(ratios.get(card.key) ?? DEFAULT_RATIO, colW, coverH, card) + ROW_GAP
    }
    return cols
  }, [cards, columns, colW, coverH, ratios])
}

export default function VideoGrid({ cards, selectedIds, onSelectionChange, showDuration, showSize, coverH, onOpen, onCardContextMenu }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null)
  const startRef = useRef<{ x: number; y: number; additive: boolean; base: Set<number>; moved: boolean } | null>(null)
  // 列数：按容器实际宽度与列宽自适应
  const [columns, setColumns] = useState(3)
  // 各卡片封面真实比例（key → ratio），用于分列高度估算；稳定后不再变化
  const [ratios, setRatios] = useState<Map<string, number>>(() => new Map())
  const ratiosRef = useRef(ratios)
  // 比例变更的批处理缓冲（避免每张封面加载都触发一次全局重排）
  const pendingRatios = useRef(new Map<string, number>())
  const flushHandle = useRef<number | null>(null)

  // 卸载时取消未执行的批处理
  useEffect(() => () => {
    if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current)
  }, [])

  const colW = columnWidth(coverH)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const compute = () => {
      const w = el.clientWidth
      if (!w) return
      // 以横图典型宽度（coverH × 16/9）为参考列宽，保证列数随封面尺寸同步变化
      const n = Math.max(1, Math.floor((w + COL_GAP) / (colW + COL_GAP)))
      setColumns(n)
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [colW, cards.length])

  /**
   * 收集卡片封面比例：用 rAF 批量合并更新。
   * 关键：图片是逐张加载完成的，若每张都 setState 会造成 N 次全量重排（滚动加载时表现为闪烁），
   * 这里把一帧内的所有比例变更合并为一次更新；且比例只影响"新卡片分到哪一列"，
   * 已固化的卡片位置不会因此变动。
   */
  const handleRatio = useCallback((key: string, ratio: number) => {
    const cur = ratiosRef.current
    if (cur.get(key) === ratio) return
    pendingRatios.current.set(key, ratio)
    if (flushHandle.current !== null) return
    flushHandle.current = requestAnimationFrame(() => {
      flushHandle.current = null
      const batch = pendingRatios.current
      pendingRatios.current = new Map()
      const next = new Map(ratiosRef.current)
      for (const [k, v] of batch) next.set(k, v)
      ratiosRef.current = next
      setRatios(next)
    })
  }, [])

  // 卡片集合变化时清理已失效的比例记录
  useEffect(() => {
    const alive = new Set(cards.map((c) => c.key))
    let changed = false
    const next = new Map(ratiosRef.current)
    for (const k of [...next.keys()]) {
      if (!alive.has(k)) {
        next.delete(k)
        changed = true
      }
    }
    if (changed) {
      ratiosRef.current = next
      setRatios(next)
    }
  }, [cards])

  const cols = useWaterfallLayout(cards, columns, colW, coverH, ratios)
  // 卡片 key → 原始索引（用于入场动画延迟），避免渲染时逐个 indexOf 造成 O(n²)
  const indexMap = useMemo(() => new Map(cards.map((c, i) => [c.key, i])), [cards])

  // 是否按住 Ctrl/Shift（多选模式）：用于切换卡片光标样式
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  useEffect(() => {
    const update = (e: KeyboardEvent) => setMultiSelectMode(e.ctrlKey || e.metaKey || e.shiftKey)
    const clear = (e: KeyboardEvent) => setMultiSelectMode(e.ctrlKey || e.metaKey || e.shiftKey)
    const onBlur = () => setMultiSelectMode(false)
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', clear)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', update)
      window.removeEventListener('keyup', clear)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // Shift 区间选择的锚点（最后一次 Ctrl/Shift 点击或框选的卡片 key）
  const anchorRef = useRef<string | null>(null)
  // 最近一次框选命中的卡片 key（用于设置锚点）
  const lastHitsRef = useRef<Set<string>>(new Set())
  // 多选时抑制卡片 click（避免打开详情）
  const suppressClickRef = useRef(false)
  // 按 key 缓存 ratio 回调，保证引用稳定（内联箭头会让 memo 失效）
  const ratioCbCache = useRef(new Map<string, (r: number) => void>())
  const ratioCb = useCallback((key: string) => {
    const cache = ratioCbCache.current
    let fn = cache.get(key)
    if (!fn) {
      fn = (r: number) => handleRatio(key, r)
      cache.set(key, fn)
    }
    return fn
  }, [handleRatio])

  // Esc 清空选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedIds.size > 0) onSelectionChange(new Set())
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, onSelectionChange])

  /** 按 DOM 顺序收集容器内所有卡片的 key 与视频 id（用于 Shift 区间选择的顺序基准）。 */
  function collectAll(): { key: string; ids: number[] }[] {
    const wrap = wrapRef.current
    if (!wrap) return []
    const out: { key: string; ids: number[] }[] = []
    wrap.querySelectorAll<HTMLElement>('[data-card]').forEach((el) => {
      const key = el.getAttribute('data-key')
      if (!key) return
      const ids = (el.getAttribute('data-vids') ?? '').split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
      out.push({ key, ids })
    })
    return out
  }

  /** 计算与矩形相交的卡片 key 与视频 id（视口坐标比较）。 */
  function hitsIn(box: { x1: number; y1: number; x2: number; y2: number }): { keys: Set<string>; ids: Set<number> } {
    const wrap = wrapRef.current
    const keys = new Set<string>()
    const ids = new Set<number>()
    if (!wrap) return { keys, ids }
    const left = Math.min(box.x1, box.x2)
    const right = Math.max(box.x1, box.x2)
    const top = Math.min(box.y1, box.y2)
    const bottom = Math.max(box.y1, box.y2)
    wrap.querySelectorAll<HTMLElement>('[data-card]').forEach((el) => {
      const r = el.getBoundingClientRect()
      if (r.right < left || r.left > right || r.bottom < top || r.top > bottom) return
      const key = el.getAttribute('data-key')
      if (key) keys.add(key)
      for (const s of (el.getAttribute('data-vids') ?? '').split(',')) {
        const id = Number(s)
        if (Number.isInteger(id) && id > 0) ids.add(id)
      }
    })
    return { keys, ids }
  }

  /**
   * Ctrl / Shift + 点击卡片：多选（拦截 click，不打开详情）。
   * - Ctrl：切换该卡片的选中状态，并把它设为区间锚点
   * - Shift：以锚点为起点做区间全选（资源管理器习惯）；无锚点时等同 Ctrl
   */
  function onCardMouseDown(e: React.MouseEvent): boolean {
    if (e.button !== 0) return false
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return false // 普通点击 → 保持打开详情

    const cardEl = (e.target as Element).closest('[data-card]') as HTMLElement | null
    if (!cardEl) return false
    const key = cardEl.getAttribute('data-key')
    if (!key) return false

    const ids = (cardEl.getAttribute('data-vids') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)

    if (e.shiftKey && anchorRef.current && anchorRef.current !== key) {
      // 区间全选：按 DOM（视觉）顺序，取锚点到当前卡片之间的所有卡片。
      // 注意不能用 cards 数组顺序——瀑布流分列后数组顺序 ≠ 视觉顺序。
      const order = collectAll()
      const from = order.findIndex((c) => c.key === anchorRef.current)
      const to = order.findIndex((c) => c.key === key)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const range = new Set<number>()
        for (let i = lo; i <= hi; i++) {
          for (const id of order[i].ids) range.add(id)
        }
        onSelectionChange(new Set([...selectedIds, ...range]))
        return true
      }
    }

    // Ctrl 切换：已全选则取消，否则加入
    const allSelected = ids.length > 0 && ids.every((id) => selectedIds.has(id))
    const next = new Set(selectedIds)
    for (const id of ids) {
      if (allSelected) next.delete(id)
      else next.add(id)
    }
    onSelectionChange(next)
    anchorRef.current = key
    return true
  }

  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    // 卡片上按下：先尝试多选；否则不框选（保留打开/拖拽行为）
    if ((e.target as Element).closest('[data-card]')) {
      if (onCardMouseDown(e)) {
        // 多选已处理 → 阻止后续 click 打开详情，并避免拖动时选中文字
        e.preventDefault()
        suppressClickRef.current = true
        document.body.style.userSelect = 'none'
        const clear = () => {
          document.body.style.userSelect = ''
          // 在 click 事件之后清除拦截标记
          setTimeout(() => { suppressClickRef.current = false }, 0)
          document.removeEventListener('mouseup', clear)
        }
        document.addEventListener('mouseup', clear)
      }
      return
    }
    const additive = e.ctrlKey || e.metaKey
    startRef.current = { x: e.clientX, y: e.clientY, additive, base: new Set(selectedIds), moved: false }

    const onMove = (ev: MouseEvent) => {
      const start = startRef.current
      if (!start) return
      const w = ev.clientX - start.x
      const h = ev.clientY - start.y
      // 移动超过阈值才算框选，避免误触
      if (!start.moved && Math.abs(w) < 5 && Math.abs(h) < 5) return
      start.moved = true
      setMarquee({ x: Math.min(start.x, ev.clientX), y: Math.min(start.y, ev.clientY), w: Math.abs(w), h: Math.abs(h) })
      const hits = hitsIn({ x1: start.x, y1: start.y, x2: ev.clientX, y2: ev.clientY })
      lastHitsRef.current = hits.keys
      onSelectionChange(start.additive ? new Set([...start.base, ...hits.ids]) : hits.ids)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      const start = startRef.current
      startRef.current = null
      setMarquee(null)
      // 未拖动的空白点击 → 清空选择（追加模式下保留）
      if (start && !start.moved && !start.additive) onSelectionChange(new Set())
      // 框选后把锚点设为最后一帧命中的首张卡片，便于后续 Shift 区间选择
      if (start?.moved && lastHitsRef.current.size > 0) {
        const firstKey = [...lastHitsRef.current][0]
        anchorRef.current = firstKey
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  if (cards.length === 0) {
    return (
      <div className='flex flex-1 items-center justify-center text-slate-500'>
        没有视频。先在右上角「文件夹」添加监控目录，然后点「扫描」。
      </div>
    )
  }
  return (
    <>
      <div
        ref={wrapRef}
        className='flex items-start gap-4 p-4'
        onMouseDown={onMouseDown}
        // 捕获阶段拦截：多选操作后阻止卡片 click 冒泡到 onOpen（避免误打开详情）
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return
          if (!(e.target as Element).closest('[data-card]')) return
          e.stopPropagation()
          e.preventDefault()
        }}
      >
        {/* 每列一个 flex-col；列内为正常文档流，卡片紧密堆叠 */}
        {cols.map((col, ci) => (
          <div key={ci} className='flex min-w-0 flex-1 flex-col' style={{ maxWidth: colW, gap: ROW_GAP }}>
            {col.map((card) => (
              <Card
                key={card.key}
                card={card}
                index={indexMap.get(card.key) ?? 0}
                selected={card.videos.every((v) => selectedIds.has(v.id))}
                showDuration={showDuration}
                showSize={showSize}
                coverH={coverH}
                colW={colW}
                multiSelectMode={multiSelectMode}
                onRatioResolved={ratioCb(card.key)}
                onOpen={onOpen}
                onCardContextMenu={onCardContextMenu}
              />
            ))}
          </div>
        ))}
      </div>
      {/* 框选矩形（fixed 定位，直接使用视口坐标） */}
      {marquee && (
        <div
          className='pointer-events-none fixed z-40 rounded border border-cyan-400 bg-cyan-400/15'
          style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
        />
      )}
    </>
  )
}
