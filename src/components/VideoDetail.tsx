import { useCallback, useEffect, useRef, useState } from 'react'
import { useDialog } from './DialogProvider'
import type { VideoDetailDto } from '../type/library'
import { mediaUrl } from '../utils/media'

interface Props {
  videoId: number
  onClose(): void
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

export default function VideoDetail({ videoId, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const infoRef = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState<VideoDetailDto | null>(null)
  const [playerError, setPlayerError] = useState('')
  // 对话框尺寸：按视频真实分辨率自适应（loadedmetadata 时计算）
  const [box, setBox] = useState<{ w: number; h: number } | null>(null)
  const { alert } = useDialog()

  // 依视频纵横比在可用空间（96vw/92vh 扣除信息区）内计算对话框大小
  const fitBox = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return
    const r = v.videoWidth / v.videoHeight
    const PAD = 32 // 对话框 p-4 四周内边距
    const GAP = 12 // flex flex-col gap-3 的上下间距
    const infoH = infoRef.current?.offsetHeight ?? 96
    const availW = window.innerWidth * 0.96 - PAD
    const availH = window.innerHeight * 0.92 - PAD - GAP - infoH
    let h = availH
    let w = h * r
    if (w > availW) {
      w = availW
      h = w / r
    }
    // 温和下限：避免竖屏/超宽视频把对话框压得过窄过扁
    w = Math.max(w, 420)
    h = Math.max(h, 260)
    setBox({ w: Math.round(w) + PAD, h: Math.round(h) + PAD + GAP + infoH })
  }, [])

  useEffect(() => {
    window.addEventListener('resize', fitBox)
    return () => window.removeEventListener('resize', fitBox)
  }, [fitBox])

  // 续播位置：getVideo 异步返回后暂存，onLoadedMetadata 时应用到 video
  // （video 元素在 detail 渲染后才存在，effect 里同步读 ref 是 null，必须延迟到渲染后）
  const resumePosRef = useRef(0)
  useEffect(() => {
    let disposed = false
    window.api.getVideo(videoId).then((d) => {
      if (!d || disposed) return
      resumePosRef.current = d.play_position_sec || 0
      setDetail(d)
    })
    return () => {
      disposed = true
      // 卸载兜底：组件销毁时保存当前音量（volumechange 已实时保存，此处防漏）
      const v = videoRef.current
      if (v) window.api.setSetting({ key: 'playerVolume', value: String(v.volume) })
    }
  }, [videoId])

  // 视频元数据就绪：恢复播放位置 + 应用记忆音量（默认 10%）。
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

  return (
    <div className='fixed inset-0 z-40 flex items-center justify-center bg-black/80 p-4' onClick={onClose}>
      <div
        className='anim-dialog flex h-[min(1000px,92vh)] w-[min(1920px,96vw)] flex-col gap-3 overflow-hidden rounded-2xl border border-slate-700 bg-slate-950 p-4 shadow-2xl shadow-black/60'
        style={box ? { width: box.w, height: box.h } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
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
        <div className='relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-black'>
          <video
            ref={videoRef}
            src={src ?? undefined}
            controls
            className='max-h-full max-w-full'
            onLoadedMetadata={handleMetadata}
            onVolumeChange={(e) => {
              // 实时记忆音量（拖动音量条/静音切换都会触发）
              const v = e.currentTarget.volume
              window.api.setSetting({ key: 'playerVolume', value: String(v) })
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
          <button
            className='absolute bottom-3 right-3 z-10 rounded-lg bg-slate-900/70 px-3 py-1.5 text-xs text-slate-300 backdrop-blur-sm transition-colors hover:bg-slate-800 hover:text-white'
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
  )
}
