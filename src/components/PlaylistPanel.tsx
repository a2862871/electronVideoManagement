import { memo, useEffect, useMemo, useRef } from 'react'
import type { PlaylistItemDto } from '../type/library'
import { coverOf, formatDuration, formatSizeGB } from '../utils/media'

interface Props {
  /** 范围说明（如「演员：xxx」「目录：xxx」「搜索：xxx」） */
  title: string
  items: PlaylistItemDto[]
  /** 范围内视频总数（可能大于已载入条数，主进程上限 2000） */
  total: number
  /** 是否正在载入（首次载入时避免误显示「该范围内没有视频」） */
  loading: boolean
  /** 载入失败信息 */
  error: string
  /** 当前正在播放的视频 id */
  currentId: number
  /** 播放结束后自动播放列表中的下一个 */
  autoNext: boolean
  onToggleAutoNext(): void
  /** 点击条目切换播放 */
  onPick(id: number): void
}

/**
 * 单个条目：memo 化——大目录（上千条）下切换视频只重渲染「高亮项」的进出两行，
 * 避免整个列表重排导致的卡顿。
 */
const Row = memo(function Row({
  item,
  index,
  active,
  onPick,
  activeRef,
}: {
  item: PlaylistItemDto
  index: number
  active: boolean
  onPick(id: number): void
  activeRef?: React.RefObject<HTMLButtonElement | null>
}) {
  const dur = formatDuration(item.runtime)
  const size = formatSizeGB(item.size_bytes)
  const cover = coverOf(item)
  return (
    <button
      ref={activeRef}
      className={`flex w-full items-start gap-2 border-l-2 px-2.5 py-1.5 text-left transition-colors ${
        active ? 'border-cyan-400 bg-cyan-600/20' : 'border-transparent hover:bg-slate-800/70'
      }`}
      title={item.filename}
      onClick={() => onPick(item.id)}
    >
      {/* 缩略图（16:9 裁切）+ 左下角序号/播放中标记 */}
      <span className='relative w-16 shrink-0 overflow-hidden rounded bg-slate-800'>
        {cover ? (
          // 懒加载：上千条的大目录下只请求可视区域附近的图
          <img src={cover} alt='' loading='lazy' draggable={false} className='h-9 w-16 object-cover' />
        ) : (
          <span className='flex h-9 w-16 items-center justify-center text-[10px] text-slate-600'>无图</span>
        )}
        <span
          className={`absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-[10px] leading-4 tabular-nums ${
            active ? 'text-cyan-300' : 'text-slate-400'
          }`}
        >
          {active ? '▶' : index + 1}
        </span>
      </span>
      <span className='min-w-0 flex-1'>
        <span className={`block truncate text-xs ${active ? 'text-cyan-200' : 'text-slate-300'}`}>
          {item.title || item.filename}
        </span>
        <span className='mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-slate-500'>
          {item.part && (
            <span className='shrink-0 rounded bg-slate-700/70 px-1 text-[10px] text-slate-300'>
              {/^\d+$/.test(item.part) ? `第 ${item.part} 集` : item.part}
            </span>
          )}
          <span className='truncate'>{item.title ? item.filename : item.num || item.sub_dir || ''}</span>
        </span>
        {(dur || size) && (
          <span className='mt-0.5 block text-[10px] tabular-nums text-slate-600'>
            {[dur, size].filter(Boolean).join(' · ')}
          </span>
        )}
      </span>
    </button>
  )
})

/** 播放列表：显示当前文件夹/演员（或标签、搜索）范围内的全部视频，点击即切换播放。 */
export default function PlaylistPanel({ title, items, total, loading, error, currentId, autoNext, onToggleAutoNext, onPick }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null)
  const curIdx = useMemo(() => items.findIndex((v) => v.id === currentId), [items, currentId])

  // 切换视频后把当前项滚入可视区域（scrollIntoView block:nearest 不打扰用户手动滚动）
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [currentId, items])

  return (
    <aside className='flex w-[320px] shrink-0 flex-col overflow-hidden rounded-lg border border-slate-700/70 bg-slate-900/50'>
      {/* 头部：范围 + 自动连播开关（不提供关闭按钮，避免误触：
          面板显隐只由底部「播放列表」按钮/快捷键 L 控制） */}
      <div className='flex items-center gap-1.5 border-b border-slate-800 px-3 py-2'>
        <div className='min-w-0 flex-1'>
          <div className='truncate text-xs font-medium text-slate-200' title={title}>
            {title}
          </div>
          <div className='mt-0.5 text-[11px] text-slate-500'>
            {loading && items.length === 0
              ? '载入中…'
              : `${items.length < total ? `${items.length} / ${total}` : total} 个${curIdx >= 0 ? ` · 第 ${curIdx + 1} 个` : ''}`}
          </div>
        </div>
        <button
          className={`shrink-0 rounded-md border px-1.5 py-1 text-[11px] leading-none transition-colors ${
            autoNext
              ? 'border-cyan-600 bg-cyan-600/20 text-cyan-300'
              : 'border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
          }`}
          title='播放结束后自动播放列表中的下一个视频'
          onClick={onToggleAutoNext}
        >
          连播
        </button>
      </div>

      {/* 列表本体 */}
      <div className='min-h-0 flex-1 overflow-y-auto py-1'>
        {error ? (
          <div className='px-3 py-6 text-center text-xs leading-relaxed text-red-300/80'>{error}</div>
        ) : loading && items.length === 0 ? (
          <div className='px-3 py-6 text-center text-xs text-slate-500'>载入中…</div>
        ) : items.length === 0 ? (
          <div className='px-3 py-6 text-center text-xs text-slate-500'>该范围内没有视频</div>
        ) : (
          items.map((it, i) => (
            <Row
              key={it.id}
              item={it}
              index={i}
              active={it.id === currentId}
              onPick={onPick}
              activeRef={it.id === currentId ? activeRef : undefined}
            />
          ))
        )}
      </div>

      {/* 超出上限时的提示（避免用户以为视频丢了） */}
      {items.length < total && (
        <div className='border-t border-slate-800 px-3 py-1.5 text-[11px] text-amber-500/80'>
          列表过长，仅载入前 {items.length} 个（共 {total} 个）
        </div>
      )}
    </aside>
  )
}
