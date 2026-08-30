/** 把时长（分钟，来自 NFO runtime）格式化为 mm:ss 或 h:mm:ss 显示。 */
export function formatDuration(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return ''
  const total = Math.round(minutes * 60)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = String(h > 0 ? m : m).padStart(h > 0 ? 2 : 1, '0')
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, '0')}` : `${mm}:${String(s).padStart(2, '0')}`
}

/**
 * 文件大小格式化为 GB，最多两位小数（如 1.2G、0.48G）。
 * 不足 1GB 时也以 G 为单位显示；无有效值返回空串。
 */
export function formatSizeGB(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / 1024 / 1024 / 1024
  // 去掉尾随 0：1.20 → 1.2，0.48 → 0.48
  return `${Number(gb.toFixed(2))}G`
}

export function mediaUrl(filePath: string | null): string | null {
  if (!filePath) return null
  if (/^(https?:|data:)/i.test(filePath)) return filePath
  // 直接用 Chromium 原生 file:// 播放本地视频（webSecurity: false 已允许）。
  // file:// 由 Chromium 处理，天然支持 Range/MIME，比自定义 local-media 协议可靠。
  const normalized = filePath.replace(/\\/g, '/')
  return `file:///${encodeURI(normalized)}`
}

/** 数据库 BLOB 缩略图地址（主进程内存缓存经自定义协议直出）；ver 为 updated_at 秒级时间戳。 */
export function thumbBlobUrl(videoId: number, ver?: number | null): string {
  return `thumbcache://img/${videoId}${ver ? `?v=${ver}` : ''}`
}

/** 封面：截取生成的 BLOB 缩略图优先，其次 NFO 自带 thumb / poster / fanart 磁盘图。 */
export function coverOf(v: {
  id: number
  thumb_blob_ver?: number | null
  poster_path: string | null
  thumb_path: string | null
  fanart_path: string | null
}): string | null {
  if (v.thumb_blob_ver) return thumbBlobUrl(v.id, v.thumb_blob_ver)
  return mediaUrl(v.thumb_path ?? v.poster_path ?? v.fanart_path)
}
