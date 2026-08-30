import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 视频压缩：ffmpeg 参数构造与执行（编码参数参考用户的 python 压缩脚本） */

export type CodecKey = 'h264' | 'hevc' | 'av1'
export type QualityKey = 'high' | 'balanced' | 'small'
export type PresetKey = 'medium' | 'slow' | 'slower' | 'veryslow'

export interface CompressConfig {
  /** 编码格式 */
  codec: CodecKey
  /** 控制方式：crf=质量优先；size=指定目标大小（两遍编码） */
  mode: 'crf' | 'size'
  /** 画质档位（crf 模式） */
  quality: QualityKey
  /** 目标大小 MB（size 模式） */
  targetMB: number
  /** 编码速度（CPU + crf 模式生效） */
  preset: PresetKey
  /** 分辨率上限（0=保持原始） */
  maxHeight: 0 | 1080 | 720 | 480
  /** 帧率上限（0=保持原始） */
  maxFps: 0 | 60 | 30 | 24
  /** 音频码率 kbps */
  audioBitrate: number
  /** 使用 NVIDIA 显卡编码（NVENC） */
  useGpu: boolean
  /** 保留字幕流 */
  keepSubtitles: boolean
  /** 仅当新文件更小时才替换原文件（否则保留原文件） */
  onlyIfSmaller: boolean
}

export const DEFAULT_COMPRESS_CONFIG: CompressConfig = {
  codec: 'hevc',
  mode: 'crf',
  quality: 'balanced',
  targetMB: 500,
  preset: 'medium',
  maxHeight: 0,
  maxFps: 0,
  audioBitrate: 128,
  useGpu: false,
  keepSubtitles: false,
  onlyIfSmaller: true,
}

// 编码器参数表（cpu/gpu 编码器名、CRF 参数名与各档位取值）
const CODECS: Record<
  CodecKey,
  {
    cpu: string
    gpu: string | null
    cpuFlag: string
    gpuFlag: string
    gpuExtra: string[]
    crf: Record<QualityKey, number>
    gpuCrf: Record<QualityKey, number>
  }
> = {
  h264: {
    cpu: 'libx264', gpu: 'h264_nvenc', cpuFlag: '-crf', gpuFlag: '-cq',
    gpuExtra: ['-preset', 'p5', '-rc', 'vbr'],
    crf: { high: 18, balanced: 20, small: 23 },
    gpuCrf: { high: 20, balanced: 23, small: 26 },
  },
  hevc: {
    cpu: 'libx265', gpu: 'hevc_nvenc', cpuFlag: '-crf', gpuFlag: '-cq',
    gpuExtra: ['-preset', 'p5', '-rc', 'vbr'],
    crf: { high: 22, balanced: 25, small: 28 },
    gpuCrf: { high: 24, balanced: 27, small: 31 },
  },
  av1: {
    cpu: 'libsvtav1', gpu: null, cpuFlag: '-crf', gpuFlag: '-cq',
    gpuExtra: [],
    crf: { high: 26, balanced: 30, small: 34 },
    gpuCrf: { high: 26, balanced: 30, small: 34 },
  },
}

export interface VideoInfo {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
  vCodec: string
  size: number
}

/** 按配置计算视频目标码率（kbps），用于 size 模式。 */
export function calcVideoBitrate(cfg: CompressConfig, durationSec: number, hasAudio: boolean): number {
  const audioKbps = hasAudio ? cfg.audioBitrate : 0
  const totalKbps = (cfg.targetMB * 1024 * 8) / Math.max(durationSec, 0.1)
  return Math.max(64, Math.round(totalKbps - audioKbps))
}

/** 查找 ffprobe：ffmpeg 同目录优先，其次系统 PATH。找不到返回 null（将回退用 ffmpeg -i 解析）。 */
export async function findFfprobe(ffmpegPath: string): Promise<string | null> {
  try {
    const ext = path.extname(ffmpegPath)
    const sibling = path.join(path.dirname(ffmpegPath), `ffprobe${ext}`)
    if (existsSync(sibling)) return sibling
  } catch {
    // 路径异常则忽略
  }
  try {
    const { stdout } = await execFileAsync(os.platform() === 'win32' ? 'where' : 'which', ['ffprobe'])
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    if (first) return first
  } catch {
    // PATH 中也没有
  }
  return null
}

/** 用 ffprobe 读取视频信息（JSON，最准确）。 */
async function probeByFfprobe(ffprobe: string, file: string): Promise<VideoInfo> {
  const { stdout } = await execFileAsync(ffprobe, [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file,
  ], { maxBuffer: 8 * 1024 * 1024 })
  const data = JSON.parse(stdout)
  const v = (data.streams ?? []).find((s: any) => s.codec_type === 'video')
  if (!v) throw new Error('没有视频流')
  const a = (data.streams ?? []).find((s: any) => s.codec_type === 'audio')
  const fmt = data.format ?? {}
  const frac = (x: unknown): number => {
    const s = String(x ?? '0')
    const [n, d] = s.split('/')
    const dn = Number(d) || 0
    return dn ? Number(n) / dn : Number(n) || 0
  }
  const st = await stat(file)
  return {
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    fps: frac(v.avg_frame_rate) || frac(v.r_frame_rate),
    duration: Number(fmt.duration) || Number(v.duration) || 0,
    hasAudio: !!a,
    vCodec: String(v.codec_name ?? '?'),
    size: Number(fmt.size) || st.size,
  }
}

/** 回退方案：从 ffmpeg -i 的 stderr 解析视频信息（无 ffprobe 时使用）。 */
async function probeByFfmpeg(ffmpeg: string, file: string): Promise<VideoInfo> {
  const { stderr } = await execFileAsync(ffmpeg, ['-hide_banner', '-i', file], { maxBuffer: 8 * 1024 * 1024 })
  const text = String(stderr ?? '')
  const durM = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  const duration = durM ? Number(durM[1]) * 3600 + Number(durM[2]) * 60 + Number(durM[3]) : 0
  const vM = /Stream #\d+:\d+.*?Video:\s*(\w+)[^,]*,[^,]*,\s*(\d{2,5})x(\d{2,5})/.exec(text)
  const fpsM = vM ? /([\d.]+)\s*(?:fps|tbr)/.exec(text.slice(vM.index)) : null
  const hasAudio = /Stream #\d+:\d+.*?Audio:/.test(text)
  const st = await stat(file)
  return {
    width: vM ? Number(vM[2]) : 0,
    height: vM ? Number(vM[3]) : 0,
    fps: fpsM ? Number(fpsM[1]) : 0,
    duration,
    hasAudio,
    vCodec: vM ? vM[1] : '?',
    size: st.size,
  }
}

/** 读取视频信息：优先 ffprobe，缺失时回退 ffmpeg 解析。 */
export async function probeVideo(ffmpeg: string, ffprobe: string | null, file: string): Promise<VideoInfo> {
  if (ffprobe) {
    try {
      return await probeByFfprobe(ffprobe, file)
    } catch {
      // ffprobe 失败 → 回退
    }
  }
  return probeByFfmpeg(ffmpeg, file)
}

/** 构造 ffmpeg 参数（passNo: 0=单遍, 1=两遍之分析, 2=两遍之编码）。 */
export function buildArgs(
  src: string,
  dst: string,
  info: VideoInfo,
  cfg: CompressConfig,
  passNo = 0,
  passLog = '',
): string[] {
  const spec = CODECS[cfg.codec]
  const useGpu = cfg.useGpu && !!spec.gpu
  const enc = useGpu ? spec.gpu! : spec.cpu

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', src]
  if (passNo) args.push('-pass', String(passNo), '-passlogfile', passLog)

  // 滤镜：帧率限制 + 分辨率限制（并保证宽高为偶数）
  const vf: string[] = []
  if (cfg.maxFps && info.fps > cfg.maxFps + 0.05) vf.push(`fps=${cfg.maxFps}`)
  if (cfg.maxHeight && info.height > cfg.maxHeight) vf.push(`scale=w=-2:h=${cfg.maxHeight}:flags=lanczos`)
  if (vf.length) vf.push('scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2')
  if (vf.length) args.push('-vf', vf.join(','))

  args.push('-map', '0:v:0')
  if (info.hasAudio) args.push('-map', '0:a:0?')
  if (cfg.keepSubtitles) args.push('-map', '0:s?', '-c:s', 'copy')
  args.push('-map_metadata', '0')

  args.push('-c:v', enc)
  if (cfg.codec === 'av1' && !useGpu) {
    args.push('-preset', '8') // SVT-AV1: 0~13，越大越快
  } else if (useGpu) {
    args.push(...spec.gpuExtra)
  } else if (passNo === 0) {
    args.push('-preset', cfg.preset)
  }

  if (cfg.mode === 'crf') {
    args.push(useGpu ? spec.gpuFlag : spec.cpuFlag, String(useGpu ? spec.gpuCrf[cfg.quality] : spec.crf[cfg.quality]))
  } else {
    const kbps = calcVideoBitrate(cfg, info.duration, info.hasAudio)
    args.push('-b:v', `${kbps}k`)
    if (passNo === 2) args.push('-bufsize', `${kbps * 2}k`, '-maxrate', `${kbps * 2}k`)
  }

  args.push('-pix_fmt', 'yuv420p')
  if ((cfg.codec === 'hevc' || cfg.codec === 'av1') && !useGpu) {
    args.push('-tag:v', cfg.codec === 'hevc' ? 'hvc1' : 'av01')
  }

  if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', `${cfg.audioBitrate}k`, '-ac', '2')
  else args.push('-an')

  args.push('-movflags', '+faststart')
  if (passNo === 1) args.push('-f', 'null', os.platform() === 'win32' ? 'NUL' : '/dev/null')
  else args.push(dst)
  return args
}

/**
 * 生成人类可读的编码参数摘要，用于在开始压缩前让用户确认实际使用的编码器与参数。
 * 例如：编码器：hevc_nvenc  参数：-cq 27 -preset p5 -rc vbr
 */
export function describeEncodeArgs(cfg: CompressConfig): { encoder: string; args: string } {
  const spec = CODECS[cfg.codec]
  const useGpu = cfg.useGpu && !!spec.gpu
  const enc = useGpu ? spec.gpu! : spec.cpu

  const parts: string[] = []
  if (cfg.mode === 'crf') {
    const value = useGpu ? spec.gpuCrf[cfg.quality] : spec.crf[cfg.quality]
    parts.push(useGpu ? spec.gpuFlag : spec.cpuFlag, String(value))
  } else {
    parts.push('-b:v', '<按视频时长计算>k')
  }

  if (cfg.codec === 'av1' && !useGpu) parts.push('-preset', '8')
  else if (useGpu) parts.push(...spec.gpuExtra)
  else if (cfg.mode === 'crf' || !needTwoPass(cfg)) parts.push('-preset', cfg.preset)

  parts.push('-pix_fmt', 'yuv420p')
  if ((cfg.codec === 'hevc' || cfg.codec === 'av1') && !useGpu) {
    parts.push('-tag:v', cfg.codec === 'hevc' ? 'hvc1' : 'av01')
  }
  parts.push('-c:a', 'aac', '-b:a', `${cfg.audioBitrate}k`)

  return { encoder: enc, args: parts.join(' ') }
}

/** 两遍编码的临时日志文件前缀（配合 buildArgs 的 passLog）。 */
export function passLogPath(dst: string): string {
  return dst.replace(/\.mp4$/i, '') + '_ffpass'
}

/** size 模式是否需要两遍（GPU 下不支持两遍）。 */
export function needTwoPass(cfg: CompressConfig): boolean {
  return cfg.mode === 'size' && !cfg.useGpu
}

export interface RunProgress {
  /** 当前这一遍的进度百分比 */
  percent: number
  speed: string
  outSize: number
}

/**
 * 执行 ffmpeg 并解析 -progress 输出。
 * onProgress 会持续回调；返回退出码与错误输出。
 */
export function runFfmpeg(
  ffmpeg: string,
  args: string[],
  duration: number,
  onProgress: (p: RunProgress) => void,
): { promise: Promise<{ code: number; error: string }>; cancel(): void } {
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stderr = ''
  let cancelled = false
  let buffer = ''

  const state: RunProgress = { percent: 0, speed: '', outSize: 0 }

  const handleLine = (raw: string): void => {
    const line = raw.trim()
    if (!line) return
    if (line.startsWith('out_time_us=')) {
      const v = line.slice('out_time_us='.length)
      const us = Number(v)
      if (!Number.isFinite(us)) return
      const cur = us / 1_000_000
      state.percent = duration > 0 ? Math.min(99.9, (cur / duration) * 100) : 0
      onProgress({ ...state })
    } else if (line.startsWith('out_time_ms=')) {
      // 某些版本是毫秒；此处按微秒已覆盖，忽略避免进度跳变
    } else if (line.startsWith('speed=')) {
      state.speed = line.slice('speed='.length).trim()
      onProgress({ ...state })
    } else if (line.startsWith('total_size=')) {
      const n = Number(line.slice('total_size='.length))
      if (Number.isFinite(n)) {
        state.outSize = n
        onProgress({ ...state })
      }
    } else if (line === 'progress=end') {
      state.percent = 100
      onProgress({ ...state })
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const l of lines) handleLine(l)
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf-8')
    if (stderr.length < 20000) stderr += s
  })

  const promise = new Promise<{ code: number; error: string }>((resolve) => {
    proc.on('error', (e: Error) => {
      if (cancelled) resolve({ code: -1, error: '' })
      else resolve({ code: -1, error: e.message })
    })
    proc.on('close', (code: number | null) => {
      if (buffer.trim()) handleLine(buffer)
      resolve({ code: code ?? -1, error: stderr })
    })
  })

  return {
    promise,
    cancel() {
      cancelled = true
      try { proc.kill() } catch { /* 已退出 */ }
    },
  }
}

/** 与源文件同目录生成不重复的临时输出名（压缩完成后再替换原文件）。 */
export function tempOutputPath(src: string): string {
  const dir = path.dirname(src)
  const stem = path.basename(src, path.extname(src))
  return path.join(dir, `${stem}.videolib-compress-${Date.now()}-${Math.floor(Math.random() * 1e6)}.mp4`)
}

/** 压缩后的最终文件名：与原文件同名的 .mp4；若已存在则加序号。 */
export function finalPathFor(src: string): string {
  const dir = path.dirname(src)
  const stem = path.basename(src, path.extname(src))
  let p = path.join(dir, `${stem}.mp4`)
  if (path.resolve(p) === path.resolve(src)) return p
  let i = 2
  while (existsSync(p)) {
    p = path.join(dir, `${stem}(${i}).mp4`)
    i++
  }
  return p
}
