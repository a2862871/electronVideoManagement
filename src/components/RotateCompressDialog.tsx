import { useEffect, useRef, useState } from 'react'

/** 参与旋转压缩的视频（单个或批量时列表中的一项） */
export interface RotateTarget {
  filename: string
  /** 该视频当前的播放旋转角度（作为输入默认值的参考） */
  rotation?: number
}

/** 分辨率上限档位（与压缩配置 maxHeight 一致：0=保持原始；1440=2K/2560×1440） */
export const RESOLUTION_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: '原分辨率' },
  { value: 1440, label: '2K' },
  { value: 1080, label: '1080p' },
  { value: 720, label: '720p' },
]

/**
 * 旋转压缩对话框（支持单个 / 批量）：
 * 手动输入旋转角度并确认后，按当前压缩配置重新编码，
 * 把旋转烧录进画面（原文件被压缩后的新文件替换）。
 * 角度按 90° 步进归一化（0/90/180/270）；0 等同普通压缩。
 * 可选择分辨率上限档位（默认当前压缩参数），确认压缩时该档位随任务下发，
 * 由主进程在确认后写回压缩参数（设置 → 视频压缩的分辨率上限）。
 * 批量时：同一角度与分辨率统一应用到所有选中视频。
 */
export default function RotateCompressDialog({
  videos,
  onClose,
  onStart,
}: {
  videos: RotateTarget[]
  onClose(): void
  onStart(rotation: number, maxHeight: number): void
}) {
  const [input, setInput] = useState(String(videos[0]?.rotation || 90))
  const [starting, setStarting] = useState(false)
  // 分辨率档位：启动时读当前压缩参数作为默认；用户手动点选后不再被读取结果覆盖
  const [maxHeight, setMaxHeight] = useState<number | null>(null)
  const resTouched = useRef(false)

  useEffect(() => {
    let alive = true
    window.api
      .getCompressConfig()
      .then((cfg) => {
        if (alive && !resTouched.current) setMaxHeight(cfg.maxHeight)
      })
      .catch(() => {
        // 读取失败回落到原分辨率
        if (alive && !resTouched.current) setMaxHeight(0)
      })
    return () => {
      alive = false
    }
  }, [])

  const count = videos.length
  const first = videos[0]
  // 所选视频当前播放旋转角度不一致时提示（统一按输入角度烧录，可能不等于各自原角度）
  const mixedRotation = videos.some((v) => (v.rotation ?? 0) !== (first?.rotation ?? 0))

  // 与主进程一致的归一化：四舍五入到 90° 步进，钳制到 0/90/180/270
  const parsed = Number(input)
  const rotation = Number.isFinite(parsed) ? ((Math.round(parsed / 90) * 90) % 360 + 360) % 360 : null
  const ready = rotation != null && maxHeight != null && !starting

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6' onClick={starting ? undefined : onClose}>
      <div
        className='anim-dialog w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='text-lg font-semibold text-slate-100'>{count > 1 ? '批量旋转压缩视频' : '旋转压缩视频'}</div>
        <div className='truncate text-xs text-slate-500' title={count > 1 ? videos.map((v) => v.filename).join('\n') : first?.filename}>
          {count > 1 ? `${first?.filename ?? ''} 等 ${count} 个视频` : first?.filename}
        </div>
        <div className='space-y-1.5'>
          <label className='block text-xs text-slate-400'>旋转角度（度，顺时针，按 90° 步进）：</label>
          <div className='flex gap-2'>
            <input
              className='w-28 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
              value={input}
              autoFocus
              onFocus={(e) => e.target.select()}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ready && onStart(rotation, maxHeight)}
            />
            {[90, 180, 270].map((deg) => (
              <button
                key={deg}
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                  rotation === deg
                    ? 'border-cyan-500 bg-cyan-600/20 text-cyan-300'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-900'
                }`}
                onClick={() => setInput(String(deg))}
              >
                {deg}°
              </button>
            ))}
          </div>
        </div>
        <div className='space-y-1.5'>
          <label className='block text-xs text-slate-400'>分辨率上限（同步到压缩参数）：</label>
          <div className='flex flex-wrap gap-2'>
            {RESOLUTION_OPTIONS.map((o) => (
              <button
                key={o.value}
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                  maxHeight === o.value
                    ? 'border-cyan-500 bg-cyan-600/20 text-cyan-300'
                    : 'border-slate-700 text-slate-300 hover:bg-slate-900'
                }`}
                onClick={() => {
                  resTouched.current = true
                  setMaxHeight(o.value)
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
        <div className='text-xs leading-relaxed text-slate-500'>
          {count > 1 ? (
            <>
              将按当前压缩配置把这 {count} 个视频重新编码并烧录相同旋转角到画面，原文件被替换；
              完成后各自的播放旋转角会自动归零。输入角度会就近取整到 90° 步进
              {rotation != null && rotation !== 0 ? <>，实际旋转：<span className='text-cyan-400'>{rotation}°</span></> : null}
              。
            </>
          ) : (
            <>
              将按当前压缩配置重新编码并把旋转烧录进画面，原文件被替换；
              完成后播放器的旋转角度会自动归零，并自动重新生成缩略图。输入角度会就近取整到 90° 步进
              {rotation != null && rotation !== 0 ? <>，实际旋转：<span className='text-cyan-400'>{rotation}°</span></> : null}
              。
            </>
          )}
          {count > 1 && mixedRotation && (
            <p className='mt-1.5 rounded-md border border-amber-700/60 bg-amber-950/40 px-2 py-1 text-amber-300'>
              所选视频当前播放旋转角度不完全一致，统一按上方输入的角度烧录，请确认是否都符合预期。
            </p>
          )}
          <p className='mt-1.5 text-slate-500'>
            所选分辨率上限将按本次旋转压缩执行，并在开始压缩时同步写回「视频压缩」设置中的分辨率上限。
          </p>
        </div>
        <div className='flex justify-end gap-2'>
          <button
            className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900'
            onClick={onClose}
          >
            取消
          </button>
          <button
            className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40'
            disabled={!ready}
            onClick={() => {
              if (rotation == null || maxHeight == null) return
              setStarting(true)
              onStart(rotation, maxHeight)
            }}
          >
            {starting ? '启动中…' : count > 1 ? `确认压缩 ${count} 个` : '确认压缩'}
          </button>
        </div>
      </div>
    </div>
  )
}
