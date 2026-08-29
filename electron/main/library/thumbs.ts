import { protocol } from 'electron'
import type { DatabaseSync } from 'node:sqlite'
import * as repo from './repo'

/**
 * 缩略图内存缓存（懒加载） + 自定义协议直出。
 * - 渲染层 <img src="thumbcache://img/{id}?v={updated_at}"> 经协议 handler 取图
 * - 首次请求某视频时从 video_thumbs 表按需读库并写入内存缓存，之后走纯内存
 * - 写入/删除缩略图时由 api.ts 同步 cacheThumb/uncacheThumb 维护一致性
 */

export const THUMB_SCHEME = 'thumbcache'

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

/** 注册 thumbcache:// 协议：thumbcache://img/{id}?v={版本}（v 仅用于绕过浏览器缓存）。 */
export function registerThumbProtocol(db: DatabaseSync): void {
  protocol.handle(THUMB_SCHEME, (request) => {
    const m = /^\/(\d+)$/.exec(new URL(request.url).pathname)
    const id = m ? Number(m[1]) : 0
    if (!id) return new Response('Not Found', { status: 404 })

    let entry = cache.get(id)
    if (!entry) {
      const row = repo.getThumbBlob(db, id)
      if (!row) return new Response('Not Found', { status: 404 })
      entry = row
      cache.set(id, entry)
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
