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
  // 画面旋转（90° 步进：0/90/180/270）：只在播放器黑色区域内旋转画面本身，
  // 对话框与信息区保持不动（不随旋转换向）。
  const [rotation, setRotation] = useState(0)
  // 旋转角度的 ref 副本：fitBox 读取它而不产生依赖（避免旋转时窗口形态跳变）
  const rotationRef = useRef(0)
  // 旋转 90/270 时画面等比缩放系数：旋转后包围盒恰好放进播放区域
  const [rotScale, setRotScale] = useState(1)
  const playerRef = useRef<HTMLDivElement>(null)
  const { alert } = useDialog()

  // 依视频纵横比在可用空间（96vw/92vh 扣除信息区）内计算对话框大小。
  // 打开播放器时按「已保存旋转角度」的方向适配窗口（旋转过 90° 的竖画面直接开竖窗）；
  // 用户点击旋转按钮时不重算窗口（画面在黑框内旋转缩放，窗口形态稳定）。
  const fitBox = useCallback(() => {
    const v = videoRef.current
    if (!v || !v.videoWidth || !v.videoHeight) return
    const rot = rotationRef.current
    const r = rot === 90 || rot === 270 ? v.videoHeight / v.videoWidth : v.videoWidth / v.videoHeight
    const PAD = 32 // 对话框 p-4 四周内边距
    const GAP = 12 // flex flex-col gap-3 的上下间距
    const BTN_BAR = 42 // 底部按钮栏（约 30px）+ 间距
    const infoH = infoRef.current?.offsetHeight ?? 96
    const availW = window.innerWidth * 0.96 - PAD
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
    setBox({ w: Math.round(w) + PAD, h: Math.round(h) + PAD + GAP + infoH + BTN_BAR })
  }, [])

  useEffect(() => {
    window.addEventListener('resize', fitBox)
    return () => window.removeEventListener('resize', fitBox)
  }, [fitBox])

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

  // 旋转 90° 并持久化到数据库（下次打开自动应用）
  const rotateVideo = useCallback(() => {
    setRotation((r) => {
      const next = (r + 90) % 360
      rotationRef.current = next
      window.api.setVideoRotation({ id: videoId, rotation: next })
      return next
    })
  }, [videoId])

  // R 键快速旋转 90°（播放器打开时生效）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'r' || e.key === 'R') rotateVideo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rotateVideo])

  // 续播位置：getVideo 异步返回后暂存，onLoadedMetadata 时应用到 video
  // （video 元素在 detail 渲染后才存在，effect 里同步读 ref 是 null，必须延迟到渲染后）
  const resumePosRef = useRef(0)
  useEffect(() => {
    let disposed = false
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
        <div ref={playerRef} className='relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-black'>
          <video
            ref={videoRef}
            src={src ?? undefined}
            controls
            className='max-h-full max-w-full'
            style={{
              transform: rotation ? `rotate(${rotation}deg) scale(${rotScale})` : undefined,
            }}
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
        </div>

        {/* 底部按钮栏：独立于播放区域，不遮挡原生进度条 */}
        <div className='flex shrink-0 items-center justify-end gap-2'>
          <button
            className='rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800 hover:text-white'
            title='旋转画面 90°（快捷键 R），角度会保存，下次打开自动应用'
            onClick={rotateVideo}
          >
            ⟳ 旋转 {rotation}°
          </button>
          <button
            className='rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-800 hover:text-white'
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
