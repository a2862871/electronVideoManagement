import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { VideoDto } from '../type/library'
import { formatDuration, formatSizeGB } from '../utils/media'

/**
 * 列表视图：以表格形式展示视频，便于查看大小/修改时间等明细与批量选择（如批量压缩）。
 * 交互与瀑布流保持一致：Ctrl 点选切换、Shift 点选区间、空白拖动框选、Esc 取消。
 * 点击表头可排序（排序仅影响列表内的显示顺序，不改后端查询）。
 */

export type SortKey = 'filename' | 'size_bytes' | 'mtime' | 'runtime' | 'sub_dir'

interface Props {
  videos: VideoDto[]
  /** 当前选中的视频 id 集合 */
  selectedIds: Set<number>
  onSelectionChange(ids: Set<number>): void
  onOpen(video: VideoDto): void
  onRowContextMenu?(e: React.MouseEvent, video: VideoDto): void
}

/** 修改时间：本地化的 YYYY-MM-DD HH:mm */
function formatMtime(ms: number | null | undefined): string {
  if (!ms || ms <= 0) return ''
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const COLS: { key: SortKey | null; label: string; cls: string; align?: 'right' }[] = [
  { key: 'filename', label: '文件名', cls: 'min-w-0 flex-1' },
  { key: 'size_bytes', label: '大小', cls: 'w-20 text-right', align: 'right' },
  { key: null, label: '时长', cls: 'w-20 text-right', align: 'right' },
  { key: 'mtime', label: '修改时间', cls: 'w-36' },
  { key: 'sub_dir', label: '所在目录', cls: 'w-48' },
]

const thCls = 'select-none px-3 py-2 text-xs font-medium text-slate-400'
const tdCls = 'px-3 py-1.5 text-sm text-slate-300'

function RowInner({
  video,
  selected,
  onOpen,
  onContextMenu,
}: {
  video: VideoDto
  selected: boolean
  onOpen(video: VideoDto): void
  onContextMenu?(e: React.MouseEvent, video: VideoDto): void
}) {
  return (
    <div
      data-row
      data-vid={video.id}
      className={`flex cursor-default items-center border-b border-slate-800/50 transition-colors ${
        selected ? 'bg-cyan-500/15' : 'hover:bg-slate-800/40'
      }`}
      onClick={() => onOpen(video)}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e, video)
      }}
    >
      {/* 选中指示条 */}
      <div className={`w-0.5 shrink-0 self-stretch ${selected ? 'bg-cyan-400' : 'bg-transparent'}`} />
      <div className={`${COLS[0].cls} truncate px-3 py-1.5 text-sm ${selected ? 'text-cyan-200' : 'text-slate-200'}`} title={video.filename}>
        {video.filename}
      </div>
      <div className={`${COLS[1].cls} ${tdCls} tabular-nums`}>{formatSizeGB(video.size_bytes)}</div>
      <div className={`${COLS[2].cls} ${tdCls} tabular-nums`}>{formatDuration(video.runtime)}</div>
      <div className={`${COLS[3].cls} ${tdCls} tabular-nums text-slate-400`}>{formatMtime(video.mtime)}</div>
      <div className={`${COLS[4].cls} truncate ${tdCls} text-slate-500`} title={video.sub_dir ?? ''}>
        {video.sub_dir ?? ''}
      </div>
    </div>
  )
}

const Row = memo(RowInner)

export default function VideoTable({ videos, selectedIds, onSelectionChange, onOpen, onRowContextMenu }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [sortKey, setSortKey] = useState<SortKey | null>('filename')
  const [sortAsc, setSortAsc] = useState(true)
  // Shift 区间选择的锚点（视频 id）
  const anchorRef = useRef<number | null>(null)
  const suppressClickRef = useRef(false)

  const sorted = useMemo(() => {
    if (!sortKey) return videos
    const dir = sortAsc ? 1 : -1
    return [...videos].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (sortKey === 'size_bytes' || sortKey === 'mtime' || sortKey === 'runtime') {
        return ((av as number) ?? 0) * dir - ((bv as number) ?? 0) * dir
      }
      return String(av ?? '').localeCompare(String(bv ?? ''), 'zh-Hans-CN') * dir
    })
  }, [videos, sortKey, sortAsc])

  // 表头全选：三态由父级计算后传入，这里只判断当前页是否全选
  const allIds = useMemo(() => videos.map((v) => v.id), [videos])
  const allSelected = allIds.length > 0 && allIds.every((id) => selectedIds.has(id))

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  /** Ctrl/Shift 点击行：多选（拦截 click，不打开详情）。 */
  function handleRowMouseDown(e: React.MouseEvent, video: VideoDto): boolean {
    if (e.button !== 0) return false
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) return false

    if (e.shiftKey && anchorRef.current !== null && anchorRef.current !== video.id) {
      const from = sorted.findIndex((v) => v.id === anchorRef.current)
      const to = sorted.findIndex((v) => v.id === video.id)
      if (from >= 0 && to >= 0) {
        const [lo, hi] = from <= to ? [from, to] : [to, from]
        const range = new Set<number>()
        for (let i = lo; i <= hi; i++) range.add(sorted[i].id)
        onSelectionChange(new Set([...selectedIds, ...range]))
        return true
      }
    }

    const next = new Set(selectedIds)
    if (next.has(video.id)) next.delete(video.id)
    else next.add(video.id)
    onSelectionChange(next)
    anchorRef.current = video.id
    return true
  }

  /** 空白区域拖动框选行。 */
  function onMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return

    const rowEl = (e.target as Element).closest('[data-row]') as HTMLElement | null
    if (rowEl) {
      const id = Number(rowEl.getAttribute('data-vid'))
      const video = sorted.find((v) => v.id === id)
      if (video && handleRowMouseDown(e, video)) {
        e.preventDefault()
        suppressClickRef.current = true
        document.body.style.userSelect = 'none'
        const clear = () => {
          document.body.style.userSelect = ''
          setTimeout(() => { suppressClickRef.current = false }, 0)
          document.removeEventListener('mouseup', clear)
        }
        document.addEventListener('mouseup', clear)
      }
      return
    }

    // 空白拖动框选
    const startY = e.clientY
    const additive = e.ctrlKey || e.metaKey
    const base = new Set(selectedIds)
    let moved = false
    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientY - startY) < 4 && Math.abs(ev.clientX - e.clientX) < 4) return
      moved = true
      const y1 = Math.min(startY, ev.clientY)
      const y2 = Math.max(startY, ev.clientY)
      const hits = new Set<number>()
      wrapRef.current?.querySelectorAll<HTMLElement>('[data-row]').forEach((el) => {
        const r = el.getBoundingClientRect()
        if (r.bottom < y1 || r.top > y2) return
        const id = Number(el.getAttribute('data-vid'))
        if (Number.isInteger(id)) hits.add(id)
      })
      onSelectionChange(additive ? new Set([...base, ...hits]) : hits)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      if (!moved && !additive) onSelectionChange(new Set())
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.body.style.userSelect = 'none'
  }

  // Esc 清空选择
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedIds.size > 0) onSelectionChange(new Set())
      // Ctrl+A 全选当前列表
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && videos.length > 0) {
        e.preventDefault()
        onSelectionChange(new Set(allIds))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedIds, onSelectionChange, videos, allIds])

  const handleOpen = useCallback((v: VideoDto) => onOpen(v), [onOpen])

  if (videos.length === 0) {
    return (
      <div className='flex flex-1 items-center justify-center text-slate-500'>
        没有视频。先在右上角「文件夹」添加监控目录，然后点「扫描」。
      </div>
    )
  }

  return (
    // 不自带滚动：由父级 main（overflow-y-auto）统一滚动，表头 sticky 相对 main 吸顶
    <div ref={wrapRef} className='flex flex-col' onMouseDown={onMouseDown}>
      {/* 表头 */}
      <div className='sticky top-0 z-10 flex items-center border-b border-slate-700 bg-slate-900/95 backdrop-blur'>
        <div className='w-0.5 shrink-0 self-stretch bg-transparent' />
        <div className={`${COLS[0].cls} ${thCls} flex items-center gap-2`}>
          <input
            type='checkbox'
            className='h-3.5 w-3.5 shrink-0 accent-cyan-500'
            checked={allSelected}
            onChange={(e) => onSelectionChange(e.target.checked ? new Set(allIds) : new Set())}
            title='全选/取消全选（当前列表）'
          />
          <button className='hover:text-slate-200' onClick={() => toggleSort('filename')}>
            文件名{sortKey === 'filename' ? (sortAsc ? ' ↑' : ' ↓') : ''}
          </button>
        </div>
        <button className={`${COLS[1].cls} ${thCls} hover:text-slate-200`} onClick={() => toggleSort('size_bytes')}>
          大小{sortKey === 'size_bytes' ? (sortAsc ? ' ↑' : ' ↓') : ''}
        </button>
        <button className={`${COLS[2].cls} ${thCls} hover:text-slate-200`} onClick={() => toggleSort('runtime')}>
          时长{sortKey === 'runtime' ? (sortAsc ? ' ↑' : ' ↓') : ''}
        </button>
        <button className={`${COLS[3].cls} ${thCls} text-left hover:text-slate-200`} onClick={() => toggleSort('mtime')}>
          修改时间{sortKey === 'mtime' ? (sortAsc ? ' ↑' : ' ↓') : ''}
        </button>
        <button className={`${COLS[4].cls} ${thCls} text-left hover:text-slate-200`} onClick={() => toggleSort('sub_dir')}>
          所在目录{sortKey === 'sub_dir' ? (sortAsc ? ' ↑' : ' ↓') : ''}
        </button>
      </div>

      {/* 行 */}
      <div
        onClickCapture={(e) => {
          if (!suppressClickRef.current) return
          if (!(e.target as Element).closest('[data-row]')) return
          e.stopPropagation()
          e.preventDefault()
        }}
      >
        {sorted.map((v) => (
          <Row
            key={v.id}
            video={v}
            selected={selectedIds.has(v.id)}
            onOpen={handleOpen}
            onContextMenu={onRowContextMenu}
          />
        ))}
      </div>
    </div>
  )
}
