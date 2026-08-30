import { protocol } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import * as repo from './repo'

/**
 * 缩略图内存缓存 + 自定义协议直出。
 * - 渲染层 <img src="thumbcache://img/{id}?v={updated_at}"> 经协议 handler 取图
 * - 加载模式（可配置）：
 *   - eager（一次加载）：启动后 preloadThumbCache 分批把 video_thumbs 全量读入内存
 *   - lazy（懒加载）：首次请求某视频时按需读库并回填缓存
 * - 写入/删除缩略图时由 api.ts 同步 cacheThumb/uncacheThumb 维护一致性
 */

export const THUMB_SCHEME = 'thumbcache'

/** 缩略图加载模式：eager=启动一次性载入内存；lazy=按需读库 */
export type ThumbLoadMode = 'eager' | 'lazy'
const THUMB_MODE_KEY = 'thumbLoadMode'

interface ThumbEntry {
  data: Buffer
  mime: string
}

const cache = new Map<number, ThumbEntry>()

export function cacheThumb(id: number, entry: ThumbEntry): void {
  cache.set(id, entry)
}

export function uncacheThumb(id: number): void {
  cache.delete(id)
}

/** 读取当前缩略图加载模式（默认 eager，与早期行为一致）。 */
export function getThumbLoadMode(db: DatabaseSync): ThumbLoadMode {
  const v = repo.getSetting(db, THUMB_MODE_KEY)
  return v === 'lazy' ? 'lazy' : 'eager'
}

/** 设置缩略图加载模式并返回生效值。切到 eager 时立即触发一次全量预加载。 */
export function setThumbLoadMode(db: DatabaseSync, mode: ThumbLoadMode): ThumbLoadMode {
  repo.setSetting(db, THUMB_MODE_KEY, mode)
  if (mode === 'eager') preloadThumbCache(db)
  return mode
}

/** 按需读库并回填缓存（懒加载路径；协议 handler 未命中时调用）。 */
function loadOne(db: DatabaseSync, id: number): ThumbEntry | undefined {
  const row = repo.getThumbBlob(db, id)
  if (row) cache.set(id, row)
  return row
}

/** 启动后调用（eager 模式）：按主键分批异步读入全部缩略图，避免大库一次性查询阻塞事件循环。 */
export function preloadThumbCache(db: DatabaseSync): void {
  const batch = 500
  const step = (afterId: number): void => {
    const rows = db
      .prepare('SELECT video_id, data, mime FROM video_thumbs WHERE video_id > ? ORDER BY video_id LIMIT ?')
      .all(afterId, batch) as { video_id: number; data: Uint8Array; mime: string }[]
    if (rows.length === 0) return
    for (const r of rows) cache.set(r.video_id, { data: Buffer.from(r.data), mime: r.mime })
    setImmediate(() => step(rows[rows.length - 1].video_id))
  }
  setImmediate(() => step(0))
}

/** 注册 thumbcache:// 协议：thumbcache://img/{id}?v={版本}（v 仅用于绕过浏览器缓存）。 */
export function registerThumbProtocol(db: DatabaseSync): void {
  protocol.handle(THUMB_SCHEME, (request) => {
    const m = /^\/(\d+)$/.exec(new URL(request.url).pathname)
    const id = m ? Number(m[1]) : 0
    if (!id) return new Response('Not Found', { status: 404 })

    let entry = cache.get(id)
    if (!entry) {
      entry = loadOne(db, id)
      if (!entry) return new Response('Not Found', { status: 404 })
    }
    return new Response(new Uint8Array(entry.data), {
      status: 200,
      headers: {
        'Content-Type': entry.mime,
        'Content-Length': String(entry.data.length),
        // 前端用 updated_at 版本号区分新旧图，这里禁用 HTTP 缓存即可
        'Cache-Control': 'no-store',
      },
    })
  })
}
