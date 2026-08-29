import { app, dialog, ipcMain, protocol, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { fileStem, parseFilename } from './filename'
import * as repo from './repo'
import { cacheThumb, uncacheThumb } from './thumbs'
import { scanWatchFolder } from './scanner'
import type { BatchUpdateArgs, VideoQuery, VideoUpdateArgs } from '../../../src/type/library'

export const MEDIA_SCHEME = 'local-media'

const execFileAsync = promisify(execFile)

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.ts': 'video/mp2t',
  '.flv': 'video/x-flv',
  '.rmvb': 'application/vnd.rn-realmedia-vbr',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.nfo': 'application/xml',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
}

/**
 * 本地媒体协议：手动实现 Range 分段返回 + 正确的 MIME。
 * 大视频（数百 MB）必须支持 Range，video 才能边下边播 / seek；
 * 不能用 net.fetch(file://)（不支持 Range，会把整文件读进内存导致失败）。
 * body 必须用 Readable.toWeb() 转成标准 Web 流，直接传 Node 流会不兼容。
 */
export function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)

    let size: number
    try {
      size = (await stat(filePath)).size
    } catch {
      return new Response('Not Found', { status: 404 })
    }

    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'

    const range = request.headers.get('Range')
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (Number.isNaN(start)) start = 0
      if (Number.isNaN(end) || end >= size) end = size - 1
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      const stream = Readable.toWeb(createReadStream(filePath, { start, end }))
      return new Response(stream as unknown as BodyInit, {
        status: 206,
        headers: {
          'Content-Type': mime,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
        },
      })
    }

    const stream = Readable.toWeb(createReadStream(filePath))
    return new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
      },
    })
  })
}

export function registerLibraryIpc(db: DatabaseSync, opts: { dataDir: string; configFile: string }): void {
  ipcMain.handle('folder:list', () => {
    return repo.listWatchFolders(db).map((f) => {
      const tag = f.tag_id
        ? (db.prepare('SELECT name FROM tags WHERE id = ?').get(f.tag_id) as { name: string } | undefined)
        : undefined
      return { id: f.id, path: f.path, name: f.name, tagName: tag?.name ?? null, browseMode: f.browse_mode }
    })
  })

  // ---------- 目录收藏（settings 表存路径 JSON 数组） ----------
  function getFavoriteDirs(): Set<string> {
    try {
      const arr = JSON.parse(repo.getSetting(db, 'favoriteDirs') ?? '[]')
      return new Set(Array.isArray(arr) ? arr.filter((s: unknown) => typeof s === 'string') : [])
    } catch {
      return new Set()
    }
  }

  ipcMain.handle('dir:toggleFavorite', (_e, dirPath: string) => {
    if (!dirPath) return false
    const favs = getFavoriteDirs()
    if (favs.has(dirPath)) favs.delete(dirPath)
    else favs.add(dirPath)
    repo.setSetting(db, 'favoriteDirs', JSON.stringify([...favs]))
    return favs.has(dirPath)
  })

  ipcMain.handle('dir:list', async (_e, dirPath: string) => {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => [])
    const favs = getFavoriteDirs()
    const rows: { name: string; path: string; count: number; favorite: boolean }[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const p = path.join(dirPath, entry.name)
      const row = db.prepare('SELECT COUNT(*) AS c FROM videos WHERE path LIKE ?').get(p + path.sep + '%') as { c: number }
      rows.push({ name: entry.name, path: p, count: row.c, favorite: favs.has(p) })
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  })

  ipcMain.handle('folder:add', (_e, args: { path: string; name: string; tagName: string | null; browseMode?: repo.BrowseMode }) => {
    const tagId = args.tagName ? repo.ensureTag(db, args.tagName) : null
    return repo.addWatchFolder(db, args.path, args.name, tagId, args.browseMode ?? 'tree')
  })

  ipcMain.handle('folder:setMode', (_e, args: { id: number; mode: repo.BrowseMode }) => {
    repo.setWatchFolderMode(db, args.id, args.mode)
  })

  ipcMain.handle('folder:update', (_e, args: { id: number; name: string; tagName: string | null }) => {
    const tagId = args.tagName ? repo.ensureTag(db, args.tagName) : null
    repo.updateWatchFolder(db, args.id, args.name, tagId)
  })

  ipcMain.handle('folder:remove', (_e, id: number) => {
    const videoIds = (db.prepare('SELECT id FROM videos WHERE folder_id = ?').all(id) as { id: number }[]).map((r) => r.id)
    db.prepare('DELETE FROM videos WHERE folder_id = ?').run(id)
    db.prepare('DELETE FROM watch_folders WHERE id = ?').run(id)
    for (const vid of videoIds) uncacheThumb(vid)
  })

  /**
   * 彻底删除一个子目录（tree 浏览模式下的目录节点）：
   * - 校验：不能等于任一监控文件夹根路径（防误删根目录）
   * - 先删除该路径下的全部视频数据库记录（外键级联清关联）
   * - 再从硬盘递归删除整个文件夹（不进回收站，不可恢复）
   */
  ipcMain.handle('dir:delete', async (_e, dirPath: string) => {
    const folders = repo.listWatchFolders(db)
    if (folders.some((f) => path.resolve(f.path).toLowerCase() === path.resolve(dirPath).toLowerCase())) {
      return { ok: false as const, error: '不能删除监控文件夹根目录，请在「文件夹」管理中操作' }
    }
    // 删除数据库记录（先于磁盘删除：即使磁盘删除失败也避免留下孤儿记录）
    const like = dirPath + path.sep + '%'
    const videoIds = (db.prepare('SELECT id FROM videos WHERE path LIKE ?').all(like) as { id: number }[]).map((r) => r.id)
    const r = db.prepare('DELETE FROM videos WHERE path LIKE ?').run(like)
    const removedVideos = Number(r.changes)
    for (const vid of videoIds) uncacheThumb(vid)
    // 彻底删除磁盘文件夹
    try {
      rmSync(dirPath, { recursive: true, force: true })
      return { ok: true as const, removedVideos }
    } catch (e: any) {
      return { ok: false as const, error: `删除文件夹失败：${e?.message ?? String(e)}`, removedVideos }
    }
  })

  /**
   * 在指定目录下新建子文件夹（tree 布局二级/三级列的右键操作）。
   * 校验名称合法性并防止覆盖同名目录。
   */
  ipcMain.handle('dir:create', async (_e, args: { parentPath: string; name: string }) => {
    const name = args.name.trim()
    if (!name) return { ok: false as const, error: '文件夹名不能为空' }
    if (/[\\/:*?"<>|]/.test(name)) return { ok: false as const, error: '文件夹名包含非法字符（\\ / : * ? " < > |）' }
    const target = path.join(args.parentPath, name)
    if (existsSync(target)) return { ok: false as const, error: `已存在同名文件或文件夹「${name}」` }
    try {
      await mkdir(target, { recursive: true })
      return { ok: true as const, path: target }
    } catch (e: any) {
      return { ok: false as const, error: `创建文件夹失败：${e?.message ?? String(e)}` }
    }
  })

  /**
   * Windows 原生文件夹对话框默认停在「文档/快速访问」视图，侧边栏与「此电脑」
   * 中不展示网络映射盘（NAS），用户找不到盘符入口。
   * 这里倒序探测已挂载盘符（Z→B，跳过 A/C），优先定位到 NAS 盘打开对话框。
   */
  function firstAccessibleDrive(): string | undefined {
    for (let c = 90; c >= 66; c--) {
      const p = `${String.fromCharCode(c)}:\\`
      try {
        statSync(p)
        return p
      } catch {
        // 盘不存在或不可访问，继续探测
      }
    }
    return undefined
  }

  ipcMain.handle('folder:pick', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      defaultPath: firstAccessibleDrive(),
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('scan:run', async (_e, args?: { folderId?: number; dirPath?: string }) => {
    const folders = repo.listWatchFolders(db)
      .filter((f) => !args?.folderId || f.id === args.folderId)
    const summaries = []
    for (const folder of folders) {
      const tag = folder.tag_id
        ? (db.prepare('SELECT name FROM tags WHERE id = ?').get(folder.tag_id) as { name: string } | undefined)
        : undefined
      // dirPath 存在时只扫描该子目录（而非整个监控文件夹根）
      const scanPath = args?.dirPath ?? folder.path
      const s = await scanWatchFolder(db, { id: folder.id, path: scanPath, rootPath: folder.path, tagName: tag?.name ?? null })
      summaries.push({ folderId: folder.id, ...s })
    }
    return summaries
  })

  ipcMain.handle('videos:query', (_e, q: VideoQuery) => {
    const where: string[] = []
    const args: (string | number)[] = []

    if (q.folderId) {
      where.push('v.folder_id = ?')
      args.push(q.folderId)
    }
    if (q.dirPath) {
      where.push('v.path LIKE ?')
      args.push(q.dirPath + path.sep + '%')
    }
    if (q.tagIds && q.tagIds.length > 0) {
      // 多标签为「同时包含」语义：每个标签一个 EXISTS，全部满足才命中
      for (const tagId of q.tagIds) {
        where.push('EXISTS (SELECT 1 FROM video_tags vt WHERE vt.video_id = v.id AND vt.tag_id = ?)')
        args.push(tagId)
      }
    }
    if (q.actorId) {
      where.push('EXISTS (SELECT 1 FROM video_actors va WHERE va.video_id = v.id AND va.actor_id = ?)')
      args.push(q.actorId)
    }
    if (q.subDir) {
      where.push('v.sub_dir = ?')
      args.push(q.subDir)
    }
    if (q.search) {
      where.push(`(
        v.title LIKE ? OR v.num LIKE ? OR v.filename LIKE ?
        OR EXISTS (
          SELECT 1 FROM video_actors va JOIN actors a ON a.id = va.actor_id
          WHERE va.video_id = v.id AND (a.name LIKE ? OR a.alias LIKE ?)
        )
      )`)
      const like = `%${q.search}%`
      args.push(like, like, like, like, like)
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM videos v ${whereSql}`).get(...args) as { c: number }).c
    const limit = q.limit ?? 60
    const offset = q.offset ?? 0
    const orderSql = q.sort === 'oldest'
      ? 'ORDER BY v.created_at ASC, v.id ASC'
      : 'ORDER BY v.created_at DESC, v.id DESC'
    // thumb_blob_ver：video_thumbs.updated_at 的秒级时间戳（0 = 无 BLOB），前端用作图片缓存版本号
    const rows = db.prepare(
      `SELECT v.*, COALESCE(CAST(strftime('%s', t.updated_at) AS INTEGER), 0) AS thumb_blob_ver
       FROM videos v LEFT JOIN video_thumbs t ON t.video_id = v.id
       ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset)

    return { total, rows }
  })

  ipcMain.handle('video:get', (_e, id: number) => {
    const row = db.prepare(`
      SELECT v.*, COALESCE(CAST(strftime('%s', t.updated_at) AS INTEGER), 0) AS thumb_blob_ver
      FROM videos v LEFT JOIN video_thumbs t ON t.video_id = v.id
      WHERE v.id = ?
    `).get(id) as (repo.VideoRow & { thumb_blob_ver: number }) | undefined
    if (!row) return null
    const actors = db.prepare(`
      SELECT a.name FROM video_actors va JOIN actors a ON a.id = va.actor_id WHERE va.video_id = ?
    `).all(id) as { name: string }[]
    const tags = db.prepare(`
      SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ?
    `).all(id) as { name: string }[]
    return { ...row, actors: actors.map((a) => a.name), tags: tags.map((t) => t.name) }
  })

  ipcMain.handle('video:update', (_e, args: VideoUpdateArgs) => {
    db.prepare(`
      UPDATE videos SET title = ?, num = ?, part = ?, sub_dir = ?, plot = ?, releasedate = ?,
        studio = ?, series = ?, rating = ?, originaltitle = ?, runtime = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      args.title ?? null, args.num ?? null, args.part ?? null, args.sub_dir ?? null,
      args.plot ?? null, args.releasedate ?? null, args.studio ?? null, args.series ?? null,
      args.rating ?? null, args.originaltitle ?? null, args.runtime ?? null, args.id,
    )
    if (args.actorNames) {
      repo.setVideoActors(db, args.id, args.actorNames.filter(Boolean).map((n) => repo.ensureActor(db, n)))
    }
    if (args.tagNames) {
      db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(args.id)
      repo.addVideoTags(db, args.id, args.tagNames.filter(Boolean).map((n) => repo.ensureTag(db, n)))
    }
  })

  /**
   * 批量更新视频信息：仅处理提交的字段（未传字段不动）。
   * 演员/标签支持替换（set*）或追加（add*，INSERT OR IGNORE 不覆盖已有关联）。
   * 返回受影响的视频数量。
   */
  ipcMain.handle('video:batchUpdate', (_e, args: BatchUpdateArgs) => {
    const ids = (args.ids ?? []).filter((n) => Number.isInteger(n))
    if (ids.length === 0) return 0

    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (args.sub_dir !== undefined) { sets.push('sub_dir = ?'); vals.push(args.sub_dir || null) }
    if (args.studio !== undefined) { sets.push('studio = ?'); vals.push(args.studio || null) }
    if (args.series !== undefined) { sets.push('series = ?'); vals.push(args.series || null) }
    if (args.releasedate !== undefined) { sets.push('releasedate = ?'); vals.push(args.releasedate || null) }
    if (args.rating !== undefined) { sets.push('rating = ?'); vals.push(args.rating || null) }
    if (sets.length > 0) {
      sets.push("updated_at = datetime('now')")
      const placeholders = ids.map(() => '?').join(',')
      db.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id IN (${placeholders})`).run(...vals, ...ids)
    }

    for (const id of ids) {
      if (args.setActors) {
        repo.setVideoActors(db, id, args.setActors.map((n) => repo.ensureActor(db, n)))
      }
      if (args.setTags) {
        db.prepare('DELETE FROM video_tags WHERE video_id = ?').run(id)
        repo.addVideoTags(db, id, args.setTags.map((n) => repo.ensureTag(db, n)))
      }
      if (args.addActors?.length) {
        db.prepare(`
          INSERT OR IGNORE INTO video_actors(video_id, actor_id)
          SELECT ?, id FROM actors WHERE name IN (${args.addActors.map(() => '?').join(',')})
        `).run(id, ...args.addActors)
      }
      if (args.addTags?.length) {
        db.prepare(`
          INSERT OR IGNORE INTO video_tags(video_id, tag_id)
          SELECT ?, id FROM tags WHERE name IN (${args.addTags.map(() => '?').join(',')})
        `).run(id, ...args.addTags)
      }
    }

    return ids.length
  })

  ipcMain.handle('tags:list', () => {
    return db.prepare(`
      SELECT t.id, t.name, COUNT(vt.video_id) AS count
      FROM tags t LEFT JOIN video_tags vt ON vt.tag_id = t.id
      GROUP BY t.id ORDER BY count DESC, t.name
    `).all()
  })

  ipcMain.handle('tags:create', (_e, name: string) => repo.ensureTag(db, name))

  ipcMain.handle('tags:rename', (_e, args: { id: number; name: string }) => {
    try {
      db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(args.name, args.id)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('tags:delete', (_e, id: number) => {
    db.prepare('DELETE FROM tags WHERE id = ?').run(id)
  })

  // ---------- 演员收藏（settings 表存 id JSON 数组） ----------
  function getActorFavorites(): Set<number> {
    try {
      const arr = JSON.parse(repo.getSetting(db, 'actorFavorites') ?? '[]')
      return new Set(Array.isArray(arr) ? arr.filter((n: unknown) => Number.isInteger(n)) : [])
    } catch {
      return new Set()
    }
  }

  ipcMain.handle('actor:toggleFavorite', (_e, actorId: number) => {
    if (!Number.isInteger(actorId)) return false
    const favs = getActorFavorites()
    if (favs.has(actorId)) favs.delete(actorId)
    else favs.add(actorId)
    repo.setSetting(db, 'actorFavorites', JSON.stringify([...favs]))
    return favs.has(actorId)
  })

  // 演员列表：可选按文件夹过滤。排序时将主名与曾用名合并，
  // 取该演员所有名字中字母序最早者决定其在列表中的位置。
  ipcMain.handle('actors:list', (_e, folderId?: number) => {
    const favs = getActorFavorites()
    const sql = folderId
      ? `
        SELECT a.id, a.name, a.alias, COUNT(va.video_id) AS count
        FROM actors a
        JOIN video_actors va ON va.actor_id = a.id
        JOIN videos v ON v.id = va.video_id AND v.folder_id = ?
        GROUP BY a.id
      `
      : `
        SELECT a.id, a.name, a.alias, COUNT(va.video_id) AS count
        FROM actors a LEFT JOIN video_actors va ON va.actor_id = a.id
        GROUP BY a.id
      `
    const rows = folderId
      ? db.prepare(sql).all(folderId) as { id: number; name: string; alias: string | null; count: number }[]
      : db.prepare(sql).all() as { id: number; name: string; alias: string | null; count: number }[]
    const sortKey = (a: { name: string; alias: string | null }): string => {
      const names = [a.name, ...(a.alias ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)]
      return names.sort((x, y) => x.localeCompare(y, 'zh-Hans-CN'))[0]
    }
    return rows
      .map((r) => ({ ...r, favorite: favs.has(r.id) }))
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'zh-Hans-CN'))
  })

  ipcMain.handle('actors:setAlias', (_e, args: { id: number; alias: string }) => {
    repo.setActorAlias(db, args.id, args.alias.trim() || null)
  })

  // 手动新增演员；若名字已存在则返回其 id 且 created=false
  ipcMain.handle('actors:create', (_e, name: string) => {
    const n = name.trim()
    if (!n) return { ok: false as const, error: '名字不能为空' }
    const existing = db.prepare('SELECT id FROM actors WHERE name = ?').get(n) as { id: number } | undefined
    if (existing) return { ok: true as const, created: false as const, id: existing.id }
    const id = repo.ensureActor(db, n)
    return { ok: true as const, created: true as const, id }
  })

  // 删除作品数为 0 的演员，返回删除数量
  ipcMain.handle('actors:cleanup', () => {
    const r = db.prepare('DELETE FROM actors WHERE id NOT IN (SELECT DISTINCT actor_id FROM video_actors)').run()
    return Number(r.changes)
  })

  /**
   * 合并演员：将 source 的视频与曾用名并入 target，然后删除 source。
   * 二次确认使用原生对话框。
   */
  ipcMain.handle('actors:merge', async (_e, args: { targetId: number; sourceId: number }) => {
    if (args.targetId === args.sourceId) return { ok: false as const, error: '不能与自己合并' }
    const [target, source] = [
      db.prepare('SELECT * FROM actors WHERE id = ?').get(args.targetId),
      db.prepare('SELECT * FROM actors WHERE id = ?').get(args.sourceId),
    ] as ({ id: number; name: string; alias: string | null } | undefined)[]
    if (!target || !source) return { ok: false as const, error: '演员不存在' }

    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['取消', '确认合并'],
      defaultId: 1,
      cancelId: 0,
      title: '合并演员',
      message: `将「${source.name}」合并到「${target.name}」？`,
      detail: `「${source.name}」的作品将归入「${target.name}」，其曾用名并入「${target.name}」的曾用名，随后「${source.name}」将从列表中删除。此操作可撤销性有限，请确认。`,
    })
    if (response !== 1) return { ok: false as const, cancelled: true as const }

    const count = repo.mergeActor(db, args.targetId, args.sourceId)
    return { ok: true as const, count }
  })

  // ---------- 设置 ----------
  ipcMain.handle('settings:get', (_e, key: string) => repo.getSetting(db, key))

  ipcMain.handle('settings:set', (_e, args: { key: string; value: string }) => {
    repo.setSetting(db, args.key, args.value)
  })

  // ---------- 数据库目录迁移 ----------
  // 用 SQLite 原生 VACUUM INTO 在新目录生成一份完整一致的库副本（含缩略图 BLOB），
  // 全程不关闭当前连接：失败则原库分毫不动；成功写入引导配置后自动重启生效。
  ipcMain.handle('db:changeDir', async (_e, targetDir: string) => {
    const dir = path.resolve(String(targetDir ?? '').trim())
    if (!dir || dir.toLowerCase() === path.resolve(opts.dataDir).toLowerCase()) {
      return { ok: false as const, error: '新目录与当前数据目录相同' }
    }
    const targetDb = path.join(dir, 'videolib.db')
    if (existsSync(targetDb)) {
      return { ok: false as const, error: '目标目录已存在 videolib.db，为避免覆盖已有数据，请换一个空目录' }
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['取消', '迁移并重启'],
      defaultId: 1,
      cancelId: 0,
      title: '迁移数据库',
      message: `将当前数据库复制到：\n${dir}\n之后重启应用并改用新位置？`,
      detail: '复制完成前原数据库保持不变；开发版与打包版共用此配置，两边将指向同一个库。应用会自动重启以切换。',
    })
    if (response !== 1) return { ok: false as const, cancelled: true as const }

    try {
      mkdirSync(dir, { recursive: true })
      db.exec(`VACUUM INTO '${targetDb.replace(/'/g, "''")}'`)
      writeFileSync(opts.configFile, JSON.stringify({ dir }, null, 2) + '\n')
    } catch (e: any) {
      try { rmSync(targetDb, { force: true }) } catch { /* 清理半成品副本，忽略 */ }
      return { ok: false as const, error: `迁移失败：${e?.message ?? String(e)}` }
    }
    app.relaunch()
    app.exit(0)
    return { ok: true as const }
  })

  ipcMain.handle('file:pick', async (_e, opts?: { filters?: { name: string; extensions: string[] }[] }) => {
    const result = await dialog.showOpenDialog({ properties: ['openFile'], filters: opts?.filters })
    return result.canceled ? null : result.filePaths[0]
  })

  // ---------- FFmpeg 截取缩略图 ----------
  async function grabFrameByFfmpeg(ffmpeg: string, videoPath: string, timeSec: number, outPath: string) {
    try {
      await execFileAsync(
        ffmpeg,
        ['-y', '-ss', String(Math.max(0, timeSec)), '-i', videoPath, '-frames:v', '1', '-q:v', '3', outPath],
        { timeout: 30_000 },
      )
      return { ok: true as const, outPath }
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e) }
    }
  }

  /** 抽帧 → 读入内存 → 以 BLOB 存入 video_thumbs 表并写入内存缓存（不落盘为正式文件）。 */
  async function captureThumbBlob(ffmpeg: string, videoId: number, videoPath: string, timeSec: number) {
    const tmpPath = path.join(os.tmpdir(), `videolib-thumb-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`)
    try {
      const r = await grabFrameByFfmpeg(ffmpeg, videoPath, timeSec, tmpPath)
      if (!r.ok) return { ok: false as const, error: r.error ?? '抽帧失败' }
      const data = await readFile(tmpPath)
      repo.setThumbBlob(db, videoId, data, 'image/jpeg')
      cacheThumb(videoId, { data, mime: 'image/jpeg' })
      return { ok: true as const }
    } catch (e: any) {
      return { ok: false as const, error: e?.message ?? String(e) }
    } finally {
      rmSync(tmpPath, { force: true })
    }
  }

  // 用 ffmpeg -i 探测视频时长（秒）。ffmpeg 读取无输出文件时退出码非 0，
  // 但 stderr 会打印 Duration，两种情况都解析。
  async function probeDurationSec(ffmpeg: string, videoPath: string): Promise<number | null> {
    const parse = (stderr: string): number | null => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
      if (!m) return null
      return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3])
    }
    try {
      await execFileAsync(ffmpeg, ['-i', videoPath], { timeout: 20_000 })
      return null
    } catch (e: any) {
      return parse(e?.stderr ?? '')
    }
  }

  // 批量抽帧：对列表中每个视频取中间位置抽帧并写入数据库作为缩略图
  ipcMain.handle('ffmpeg:batchThumbs', async (e, videos: { id: number; path: string }[]) => {
    const ffmpeg = repo.getSetting(db, 'ffmpegPath')
    if (!ffmpeg) {
      await dialog.showMessageBox({
        type: 'warning',
        title: '未配置 FFmpeg',
        message: '未配置 FFmpeg 路径，无法生成缩略图。',
        detail: '请在右上角「设置」中填写 FFmpeg 可执行文件路径。',
      })
      return { cancelled: true, ok: 0, skipped: 0, failed: [] }
    }
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['取消', '确认生成'],
      defaultId: 1,
      cancelId: 0,
      title: '一键生成缩略图',
      message: `将为 ${videos.length} 个视频从中间位置抽帧并设为缩略图，是否继续？`,
      detail: '缩略图将以 BLOB 形式存入本地数据库（video_thumbs 表），启动时自动载入内存，展示零磁盘 IO。耗时取决于视频数量与大小。',
    })
    if (response !== 1) return { cancelled: true, ok: 0, skipped: 0, failed: [] }

    const total = videos.length
    let ok = 0
    let skipped = 0
    const failed: { id: number; path: string; error: string }[] = []
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i]
      e.sender.send('ffmpeg:batchThumbs:progress', { done: i, total, current: path.basename(v.path) })
      // 已有 BLOB 则跳过
      const existing = db.prepare(`
        SELECT v.thumb_path AS thumb_path,
          EXISTS (SELECT 1 FROM video_thumbs t WHERE t.video_id = v.id) AS has_blob
        FROM videos v WHERE v.id = ?
      `).get(v.id) as { thumb_path: string | null; has_blob: number } | undefined
      if (!existing) continue
      if (existing.has_blob) {
        skipped++
        continue
      }
      // 磁盘上已有缩略图文件（旧版文件式缩略图 / NFO 自带）→ 直接读入导入 BLOB，零 ffmpeg 开销
      if (existing.thumb_path && existsSync(existing.thumb_path)) {
        try {
          const data = await readFile(existing.thumb_path)
          const mime = /\.png$/i.test(existing.thumb_path)
            ? 'image/png'
            : /\.webp$/i.test(existing.thumb_path)
              ? 'image/webp'
              : 'image/jpeg'
          repo.setThumbBlob(db, v.id, data, mime)
          cacheThumb(v.id, { data, mime })
          ok++
          continue
        } catch {
          // 文件读取失败（权限/被占用），回落到 ffmpeg 抽帧
        }
      }
      const dur = await probeDurationSec(ffmpeg, v.path)
      if (!dur) {
        failed.push({ id: v.id, path: v.path, error: '无法读取视频时长' })
        continue
      }
      const r = await captureThumbBlob(ffmpeg, v.id, v.path, dur / 2)
      if (!r.ok) {
        failed.push({ id: v.id, path: v.path, error: r.error ?? '抽帧失败' })
        continue
      }
      ok++
    }
    e.sender.send('ffmpeg:batchThumbs:progress', { done: total, total, current: '' })
    return { cancelled: false, ok, skipped, failed }
  })

  // 截到临时目录，仅用于对话框预览
  ipcMain.handle('ffmpeg:grabPreview', async (_e, args: { videoPath: string; timeSec: number }) => {
    const ffmpeg = repo.getSetting(db, 'ffmpegPath')
    if (!ffmpeg) return { ok: false as const, error: '未配置 FFmpeg 路径（右上角「设置」）' }
    const outPath = path.join(os.tmpdir(), `videolib-preview-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`)
    return grabFrameByFfmpeg(ffmpeg, args.videoPath, args.timeSec, outPath)
  })

  // 截为正式缩略图：抽帧后以 BLOB 存入数据库（经内存缓存直出，不再落盘为文件）
  ipcMain.handle('ffmpeg:grabFrame', async (_e, args: { videoPath: string; videoId: number; timeSec: number }) => {
    const ffmpeg = repo.getSetting(db, 'ffmpegPath')
    if (!ffmpeg) return { ok: false as const, error: '未配置 FFmpeg 路径（右上角「设置」）' }
    return captureThumbBlob(ffmpeg, args.videoId, args.videoPath, args.timeSec)
  })

  /**
   * 移动影片到指定文件夹：移动视频文件本体，连同其同目录下的同名 NFO、
   * 封面（poster/fanart/thumb）一并迁移，并同步更新数据库路径与 sub_dir。
   * 统一缩略图目录里的缩略图（非视频同目录）不随视频移动。
   */
  async function moveFileRel(from: string, to: string): Promise<void> {
    await mkdir(path.dirname(to), { recursive: true })
    try {
      await rename(from, to)
    } catch (err: any) {
      if (err?.code === 'EXDEV') {
        await copyFile(from, to)
        await unlink(from)
      } else {
        throw err
      }
    }
  }

  ipcMain.handle('video:move', async (_e, args: { id: number; targetDir: string }) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(args.id) as repo.VideoRow | undefined
    if (!video) return { ok: false as const, error: '视频不存在（可能已删除）' }

    const srcDir = path.dirname(video.path)
    const targetDir = path.resolve(args.targetDir)
    const stem = fileStem(path.basename(video.path))
    const targetVideo = path.join(targetDir, video.filename)

    if (path.resolve(targetVideo) === path.resolve(video.path)) {
      return { ok: true as const, moved: false as const }
    }
    if (existsSync(targetVideo)) {
      return { ok: false as const, error: `目标目录已存在同名文件「${video.filename}」` }
    }

    // 先移动视频本体（核心操作，失败则直接中止）
    try {
      await moveFileRel(video.path, targetVideo)
    } catch (e: any) {
      return { ok: false as const, error: `移动视频失败：${e?.message ?? String(e)}` }
    }

    // 关联文件尽力移动：NFO 与同目录封面
    const newArt = { poster_path: video.poster_path, fanart_path: video.fanart_path, thumb_path: video.thumb_path }
    const artKinds = ['poster_path', 'fanart_path', 'thumb_path'] as const

    const nfoFrom = path.join(srcDir, stem + '.nfo')
    if (video.has_nfo && existsSync(nfoFrom)) {
      const nfoTo = path.join(targetDir, stem + '.nfo')
      if (!existsSync(nfoTo)) {
        try { await moveFileRel(nfoFrom, nfoTo) } catch { /* 忽略 NFO 移动失败 */ }
      }
    }
    for (const kind of artKinds) {
      const imgFrom = video[kind]
      if (!imgFrom || !existsSync(imgFrom)) continue
      if (path.dirname(imgFrom) !== srcDir) continue // 统一目录里的缩略图不迁移
      const imgTo = path.join(targetDir, path.basename(imgFrom))
      if (existsSync(imgTo)) continue
      try {
        await moveFileRel(imgFrom, imgTo)
        newArt[kind] = imgTo
      } catch { /* 忽略封面移动失败 */ }
    }

    // 计算新的 sub_dir（相对监控文件夹根的一级子目录；移出根范围则为 null）
    const folder = db.prepare('SELECT path FROM watch_folders WHERE id = ?').get(video.folder_id) as { path: string } | undefined
    const rel = path.relative(folder?.path ?? srcDir, targetVideo)
    const segs = rel.split(path.sep)
    const subDir = segs.length > 1 && !rel.startsWith('..') ? segs[0] : null

    db.prepare(`
      UPDATE videos SET path = ?, sub_dir = ?, poster_path = ?, fanart_path = ?, thumb_path = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(targetVideo, subDir, newArt.poster_path, newArt.fanart_path, newArt.thumb_path, video.id)

    return { ok: true as const, moved: true as const, path: targetVideo }
  })

  /**
   * 重命名影片文件：改视频文件名主干（扩展名保持不变），连同其同目录下的同名
   * NFO、以及以旧主干开头的封面（poster/fanart/thumb）一并重命名，并同步数据库。
   * 若番号来自文件名（无 NFO），则重新解析新主干更新番号/分集。
   */
  ipcMain.handle('video:rename', async (_e, args: { id: number; newName: string }) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(args.id) as repo.VideoRow | undefined
    if (!video) return { ok: false as const, error: '视频不存在（可能已删除）' }

    const newStem = args.newName.trim()
    if (!newStem) return { ok: false as const, error: '文件名不能为空' }
    if (/[\\/:*?"<>|]/.test(newStem)) return { ok: false as const, error: '文件名包含非法字符（\\ / : * ? " < > |）' }

    const dir = path.dirname(video.path)
    const oldStem = fileStem(path.basename(video.path))
    const ext = path.extname(video.path)
    if (newStem === oldStem) return { ok: true as const, renamed: false as const }

    const newVideoPath = path.join(dir, newStem + ext)
    if (existsSync(newVideoPath)) return { ok: false as const, error: `已存在同名文件「${newStem}${ext}」` }

    // 先重命名视频本体（核心操作）
    try {
      await rename(video.path, newVideoPath)
    } catch (e: any) {
      return { ok: false as const, error: `重命名视频失败：${e?.message ?? String(e)}` }
    }

    const newArt = { poster_path: video.poster_path, fanart_path: video.fanart_path, thumb_path: video.thumb_path }
    const artKinds = ['poster_path', 'fanart_path', 'thumb_path'] as const

    // 同名 NFO
    const nfoFrom = path.join(dir, oldStem + '.nfo')
    if (video.has_nfo && existsSync(nfoFrom)) {
      const nfoTo = path.join(dir, newStem + '.nfo')
      if (!existsSync(nfoTo)) {
        try { await rename(nfoFrom, nfoTo) } catch { /* 忽略 NFO 重命名失败 */ }
      }
    }
    // 以旧主干开头的同目录封面（如 旧主干-poster.jpg / 旧主干.jpg），跟随重命名
    for (const kind of artKinds) {
      const imgFrom = video[kind]
      if (!imgFrom || !existsSync(imgFrom)) continue
      if (path.dirname(imgFrom) !== dir) continue
      const base = path.basename(imgFrom)
      if (!base.startsWith(oldStem)) continue
      const imgTo = path.join(dir, newStem + base.slice(oldStem.length))
      if (existsSync(imgTo)) continue
      try {
        await rename(imgFrom, imgTo)
        newArt[kind] = imgTo
      } catch { /* 忽略封面重命名失败 */ }
    }

    // 番号来自文件名（无 NFO）时，重新解析新主干
    let num = video.num
    let part = video.part
    if (!video.has_nfo) {
      const parsed = parseFilename(newStem)
      num = parsed.num ?? null
      part = parsed.part ?? null
    }

    db.prepare(`
      UPDATE videos SET path = ?, filename = ?, num = ?, part = ?,
        poster_path = ?, fanart_path = ?, thumb_path = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(newVideoPath, newStem + ext, num, part, newArt.poster_path, newArt.fanart_path, newArt.thumb_path, video.id)

    return { ok: true as const, renamed: true as const, path: newVideoPath, filename: newStem + ext }
  })

  /**
   * 删除影片：彻底从硬盘删除（不进回收站），并连带删除同名 NFO 与缩略图，
   * 同时移除数据库记录（video_actors/video_tags 由外键级联清除）。
   * 二次确认使用原生对话框，无法撤销。
   */
  ipcMain.handle('video:delete', async (_e, id: number) => {
    const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as repo.VideoRow | undefined
    if (!row) return { ok: false as const, error: '视频不存在（可能已删除）' }

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', '彻底删除'],
      defaultId: 0,
      cancelId: 0,
      title: '删除影片（不可恢复）',
      message: `确定要从硬盘彻底删除「${row.filename}」？`,
      detail: `此操作将直接删除文件，不经过回收站，且无法恢复！\n\n${row.path}`,
    })
    if (response !== 1) return { ok: false as const, cancelled: true as const }

    const targets: { path: string; desc: string }[] = [{ path: row.path, desc: '视频文件' }]
    // 同名 NFO（与视频同目录）
    targets.push({ path: path.join(path.dirname(row.path), `${fileStem(path.basename(row.path))}.nfo`), desc: 'NFO 文件' })
    // 缩略图（若为统一目录按视频 ID 命名，属该视频专属；同目录 stem-thumb 亦同）
    if (row.thumb_path) targets.push({ path: row.thumb_path, desc: '缩略图' })

    const failed: string[] = []
    for (const t of targets) {
      try {
        rmSync(t.path, { force: true })
      } catch (e: any) {
        failed.push(`${t.desc}: ${e?.message ?? String(e)}`)
      }
    }

    db.prepare('DELETE FROM videos WHERE id = ?').run(id)
    uncacheThumb(id) // video_thumbs 由外键级联删除，同步移除内存缓存

    if (failed.length > 0) {
      return { ok: true as const, partial: true as const, failed }
    }
    return { ok: true as const }
  })

  // ---------- 外部播放（优先用配置的播放器） ----------
  ipcMain.handle('shell:openInPlayer', async (_e, filePath: string) => {
    const player = repo.getSetting(db, 'playerPath')
    if (player) {
      return new Promise<string>((resolve) => {
        const child = spawn(player, [filePath], { detached: true, stdio: 'ignore' })
        child.on('error', (err) => resolve(`启动播放器失败：${err.message}`))
        child.on('spawn', () => {
          child.unref()
          resolve('')
        })
      })
    }
    return shell.openPath(filePath)
  })

  ipcMain.handle('shell:showInFolder', (_e, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
}
