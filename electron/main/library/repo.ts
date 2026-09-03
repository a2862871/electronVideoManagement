import type { DatabaseSync } from 'node:sqlite'

export interface VideoRow {
  id: number
  folder_id: number
  path: string
  filename: string
  num: string | null
  part: string | null
  title: string | null
  originaltitle: string | null
  plot: string | null
  releasedate: string | null
  runtime: number | null
  studio: string | null
  series: string | null
  rating: number | null
  sub_dir: string | null
  poster_path: string | null
  fanart_path: string | null
  thumb_path: string | null
  has_nfo: number
  size_bytes: number | null
  mtime: number | null
  play_position_sec: number
  play_updated_at: string | null
  created_at: string
  updated_at: string
}

export interface WatchFolderRow {
  id: number
  path: string
  name: string
  tag_id: number | null
  browse_mode: 'tree' | 'actor'
  created_at: string
}

export function ensureTag(db: DatabaseSync, name: string): number {
  const existing = db.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined
  if (existing) return existing.id
  const r = db.prepare('INSERT INTO tags(name) VALUES (?)').run(name)
  return Number(r.lastInsertRowid)
}

export function ensureActor(db: DatabaseSync, name: string): number {
  const n = name.trim()
  const existing = db.prepare('SELECT id FROM actors WHERE name = ?').get(n) as { id: number } | undefined
  if (existing) return existing.id
  const r = db.prepare('INSERT INTO actors(name) VALUES (?)').run(n)
  return Number(r.lastInsertRowid)
}

/** 设置演员曾用名（逗号分隔字符串；传 null/空清除）。 */
export function setActorAlias(db: DatabaseSync, id: number, alias: string | null): void {
  db.prepare('UPDATE actors SET alias = ? WHERE id = ?').run(alias, id)
}

/**
 * 合并演员：将 source 的视频关联转移到 target，合并曾用名，然后删除 source。
 * 返回合并后 target 的作品数。
 */
export function mergeActor(db: DatabaseSync, targetId: number, sourceId: number): number {
  // 先移除 target 已有的重复关联（(video_id, actor_id) 联合主键会冲突）
  db.prepare(`
    DELETE FROM video_actors WHERE actor_id = ? AND video_id IN (
      SELECT video_id FROM video_actors WHERE actor_id = ?
    )
  `).run(sourceId, targetId)
  // 转移剩余关联
  db.prepare('UPDATE video_actors SET actor_id = ? WHERE actor_id = ?').run(targetId, sourceId)

  // 合并曾用名：source 的主名与曾用名并入 target 的 alias（去重、排除 target 主名）
  const source = db.prepare('SELECT name, alias FROM actors WHERE id = ?').get(sourceId) as { name: string; alias: string | null } | undefined
  const target = db.prepare('SELECT name, alias FROM actors WHERE id = ?').get(targetId) as { name: string; alias: string | null } | undefined
  if (source && target) {
    const merged = new Set<string>()
    for (const raw of [target.alias, source.name, source.alias]) {
      for (const piece of (raw ?? '').split(/[,，]/)) {
        const t = piece.trim()
        if (t && t !== target.name) merged.add(t)
      }
    }
    db.prepare('UPDATE actors SET alias = ? WHERE id = ?').run([...merged].join(', '), targetId)
  }

  db.prepare('DELETE FROM actors WHERE id = ?').run(sourceId)
  const r = db.prepare('SELECT COUNT(*) AS c FROM video_actors WHERE actor_id = ?').get(targetId) as { c: number }
  return r.c
}

/** 删除演员：仅移除演员记录及其与视频的关联，返回解除的关联数；视频本身不受影响。 */
export function deleteActor(db: DatabaseSync, id: number): number {
  const r = db.prepare('DELETE FROM video_actors WHERE actor_id = ?').run(id)
  db.prepare('DELETE FROM actors WHERE id = ?').run(id)
  return Number(r.changes)
}

export function getVideoByPath(db: DatabaseSync, filePath: string): VideoRow | undefined {
  return db.prepare('SELECT * FROM videos WHERE path = ?').get(filePath) as VideoRow | undefined
}

export function listFolderVideoPaths(db: DatabaseSync, folderId: number): string[] {
  const rows = db.prepare('SELECT path FROM videos WHERE folder_id = ?').all(folderId) as { path: string }[]
  return rows.map((r) => r.path)
}

export function insertVideo(db: DatabaseSync, v: Partial<VideoRow> & { folder_id: number; path: string; filename: string }): number {
  const r = db.prepare(`
    INSERT INTO videos(folder_id, path, filename, num, part, title, originaltitle, plot, releasedate,
      runtime, studio, series, rating, sub_dir, poster_path, fanart_path, thumb_path, has_nfo, size_bytes, mtime)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    v.folder_id, v.path, v.filename, v.num ?? null, v.part ?? null, v.title ?? null,
    v.originaltitle ?? null, v.plot ?? null, v.releasedate ?? null, v.runtime ?? null,
    v.studio ?? null, v.series ?? null, v.rating ?? null, v.sub_dir ?? null,
    v.poster_path ?? null, v.fanart_path ?? null, v.thumb_path ?? null,
    v.has_nfo ?? 0, v.size_bytes ?? null, v.mtime ?? null,
  )
  return Number(r.lastInsertRowid)
}

export function updateVideoFileState(
  db: DatabaseSync,
  id: number,
  state: { size_bytes: number; mtime: number; sub_dir: string | null; poster_path: string | null; fanart_path: string | null; thumb_path: string | null },
): void {
  db.prepare(`
    UPDATE videos SET size_bytes = ?, mtime = ?, sub_dir = ?, poster_path = ?, fanart_path = ?, thumb_path = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(state.size_bytes, state.mtime, state.sub_dir, state.poster_path, state.fanart_path, state.thumb_path, id)
}

export function applyNfoMetadata(db: DatabaseSync, id: number, m: {
  num?: string; title?: string; originaltitle?: string; plot?: string; releasedate?: string
  runtime?: number; studio?: string; series?: string; rating?: number
}): void {
  db.prepare(`
    UPDATE videos SET num = ?, title = ?, originaltitle = ?, plot = ?, releasedate = ?,
      runtime = ?, studio = ?, series = ?, rating = ?, has_nfo = 1, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    m.num ?? null, m.title ?? null, m.originaltitle ?? null, m.plot ?? null, m.releasedate ?? null,
    m.runtime ?? null, m.studio ?? null, m.series ?? null, m.rating ?? null, id,
  )
}

export function setVideoActors(db: DatabaseSync, videoId: number, actorIds: number[]): void {
  db.prepare('DELETE FROM video_actors WHERE video_id = ?').run(videoId)
  const stmt = db.prepare('INSERT OR IGNORE INTO video_actors(video_id, actor_id) VALUES (?, ?)')
  for (const actorId of actorIds) stmt.run(videoId, actorId)
}

export function addVideoTags(db: DatabaseSync, videoId: number, tagIds: number[]): void {
  const stmt = db.prepare('INSERT OR IGNORE INTO video_tags(video_id, tag_id) VALUES (?, ?)')
  for (const tagId of tagIds) stmt.run(videoId, tagId)
}

export function deleteVideo(db: DatabaseSync, id: number): void {
  db.prepare('DELETE FROM videos WHERE id = ?').run(id)
}

export type BrowseMode = 'tree' | 'actor'

export function addWatchFolder(
  db: DatabaseSync,
  folderPath: string,
  name: string,
  tagId: number | null,
  browseMode: BrowseMode = 'tree',
): number {
  const r = db.prepare('INSERT INTO watch_folders(path, name, tag_id, browse_mode) VALUES (?, ?, ?, ?)')
    .run(folderPath, name, tagId, browseMode)
  return Number(r.lastInsertRowid)
}

export function setWatchFolderMode(db: DatabaseSync, id: number, mode: BrowseMode): void {
  db.prepare('UPDATE watch_folders SET browse_mode = ? WHERE id = ?').run(mode, id)
}

/** 更新监控文件夹的名称与映射标签（tagId 传 null 表示无标签）。 */
export function updateWatchFolder(db: DatabaseSync, id: number, name: string, tagId: number | null): void {
  db.prepare('UPDATE watch_folders SET name = ?, tag_id = ? WHERE id = ?').run(name, tagId, id)
}

// ---------- 缩略图 BLOB（video_thumbs 表） ----------

/** 把 BLOB 行转为 { data, mime }；node:sqlite 读出的 BLOB 是 Uint8Array。 */
export function getThumbBlob(db: DatabaseSync, videoId: number): { data: Buffer; mime: string } | undefined {
  const r = db.prepare('SELECT data, mime FROM video_thumbs WHERE video_id = ?').get(videoId) as
    | { data: Uint8Array; mime: string }
    | undefined
  return r ? { data: Buffer.from(r.data), mime: r.mime } : undefined
}

/** 写入（或覆盖）某视频的缩略图 BLOB，并刷新 updated_at（用作前端缓存版本号）。 */
export function setThumbBlob(db: DatabaseSync, videoId: number, data: Uint8Array, mime = 'image/jpeg'): void {
  db.prepare(`
    INSERT INTO video_thumbs(video_id, data, mime, updated_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(video_id) DO UPDATE SET data = excluded.data, mime = excluded.mime, updated_at = datetime('now')
  `).run(videoId, data, mime)
}

export function getSetting(db: DatabaseSync, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return r?.value ?? null
}

export function setSetting(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value)
}

export function listWatchFolders(db: DatabaseSync): WatchFolderRow[] {
  // better-sqlite3 的行类型与接口无充分重叠，需经 unknown 中转断言
  return db.prepare('SELECT * FROM watch_folders ORDER BY id').all() as unknown as WatchFolderRow[]
}
