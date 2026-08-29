import { useEffect, useState } from 'react'
import type { VideoDto } from '../type/library'
import { coverOf } from '../utils/media'

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

// 封面统一高度；横/竖图均按真实比例计算宽度，宽度参差形成横向瀑布流，
// 容器比例≈图片比例，配合 object-cover 实现完整显示无裁剪。
// 原 232，按 90% 缩小为 209（保留整数）
const COVER_H = 209
const DEFAULT_RATIO = 2 / 3
const LANDSCAPE_RATIO = 16 / 9
// 竖图宽度下限比例，避免极端超长海报把卡片缩得过窄
const MIN_PORTRAIT_RATIO = 0.5
// 横图宽度上限比例，避免极端超宽图把卡片撑得过宽（覆盖到 2.39:1 宽银幕）
const MAX_LANDSCAPE_RATIO = 2.5

function useCoverRatio(src: string | null) {
  const [ratio, setRatio] = useState<number>(DEFAULT_RATIO)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setRatio(DEFAULT_RATIO)
    setFailed(false)
    if (!src) return
    const img = new Image()
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) setRatio(img.naturalWidth / img.naturalHeight)
    }
    img.onerror = () => setFailed(true)
    img.src = src
    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [src])

  return { ratio, failed, setFailed }
}

interface CardProps {
  card: WorkCard
  onOpen(video: VideoDto): void
  onCardContextMenu?(e: React.MouseEvent, video: VideoDto): void
}

function Card({ card, onOpen, onCardContextMenu, index }: CardProps & { index: number }) {
  const src = coverOf(card.videos[0])
  const { ratio, failed, setFailed } = useCoverRatio(src)
  const real = failed || !src ? LANDSCAPE_RATIO : ratio
  // 横竖图统一按真实比例计算宽度，仅对极端比例做上下限钳制以保护布局
  const width = Math.round(COVER_H * Math.min(Math.max(real, MIN_PORTRAIT_RATIO), MAX_LANDSCAPE_RATIO))

  return (
    <button
      className='anim-fade-up group shrink-0 cursor-grab overflow-hidden rounded-xl border border-slate-800 bg-slate-900 text-left shadow-lg shadow-black/30 transition-all duration-200 hover:-translate-y-1 hover:border-cyan-500/70 hover:shadow-[0_10px_32px_-8px_rgba(34,211,238,0.35)] active:cursor-grabbing'
      style={{ width, animationDelay: `${Math.min(index * 35, 420)}ms` }}
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
      <div className='relative w-full overflow-hidden bg-slate-800' style={{ height: COVER_H }}>
        {src && !failed ? (
          <img
            src={src}
            loading='lazy'
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

interface Props {
  cards: WorkCard[]
  onOpen(video: VideoDto): void
  onCardContextMenu?(e: React.MouseEvent, video: VideoDto): void
}

export default function VideoGrid({ cards, onOpen, onCardContextMenu }: Props) {
  if (cards.length === 0) {
    return (
      <div className='flex flex-1 items-center justify-center text-slate-500'>
        没有视频。先在右上角「文件夹」添加监控目录，然后点「扫描」。
      </div>
    )
  }
  return (
    <div className='flex flex-wrap items-start gap-4 p-4'>
      {cards.map((card, i) => (
        <Card key={card.key} card={card} index={i} onOpen={onOpen} onCardContextMenu={onCardContextMenu} />
      ))}
    </div>
  )
}
