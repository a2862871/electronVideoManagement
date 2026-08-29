import { useEffect, useRef, useState } from 'react'
import { mediaUrl } from '../utils/media'

interface Props {
  videoPath: string
  videoId: number
  initialTime: number
  onClose(): void
  onSaved(): void
}

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * 手动截取缩略图：用可见 video 实时预览（拖动滑块即时 seek，零 FFmpeg 开销），
 * 点「确认截取」时才用 FFmpeg 从当前时间点截一张正式缩略图。
 */
export default function CaptureDialog({ videoPath, videoId, initialTime, onClose, onSaved }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [time, setTime] = useState(initialTime)
  const [duration, setDuration] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    const onLoaded = () => {
      const dur = v.duration || 0
      setDuration(dur)
      const t = Math.min(initialTime, Math.max(0, dur - 0.5))
      setTime(t)
      v.currentTime = t
    }
    v.addEventListener('loadedmetadata', onLoaded)
    return () => v.removeEventListener('loadedmetadata', onLoaded)
  }, [videoPath])

  function onSeek(value: number) {
    setTime(value)
    const v = videoRef.current
    if (v) v.currentTime = value
  }

  async function confirm() {
    setBusy(true)
    setError('')
    const r = await window.api.grabFrame({ videoPath, videoId, timeSec: time })
    setBusy(false)
    if (!r.ok) {
      setError(r.error ?? '截取失败')
      return
    }
    onSaved()
    onClose()
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6' onClick={onClose}>
      <div
        className='anim-dialog w-full max-w-xl space-y-3 rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl shadow-black/60'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='text-lg font-semibold text-slate-100'>手动截取缩略图</div>

        <div className='overflow-hidden rounded-lg bg-black'>
          <video ref={videoRef} src={mediaUrl(videoPath) ?? undefined} className='max-h-64 w-full' preload='auto' />
        </div>

        <div className='space-y-1.5'>
          <div className='flex items-center justify-between text-xs text-slate-400'>
            <span>时间：{fmt(time)}</span>
            <span>总时长：{fmt(duration)}</span>
          </div>
          {duration > 0 ? (
            <input
              type='range'
              min={0}
              max={Math.floor(duration)}
              step={1}
              value={Math.min(time, Math.floor(duration))}
              onChange={(e) => onSeek(Number(e.target.value))}
              disabled={busy}
              className='w-full'
            />
          ) : (
            <div className='text-xs text-amber-400'>正在读取视频时长…</div>
          )}
          <div className='text-xs text-slate-500'>拖动滑块实时预览画面，点「确认截取」将当前画面保存为视频缩略图（存入数据库）。</div>
        </div>

        {error && <div className='text-sm text-amber-400'>{error}</div>}

        <div className='flex justify-end gap-2'>
          <button className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900' onClick={onClose}>
            取消
          </button>
          <button
            className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
            disabled={busy}
            onClick={confirm}
          >
            {busy ? '截取中…' : '确认截取'}
          </button>
        </div>
      </div>
    </div>
  )
}
