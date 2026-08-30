import { BrowserWindow, app, dialog, ipcMain, protocol, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import type { DatabaseSync } from 'node:sqlite'
import { fileStem, parseFilename } from './filename'
import * as repo from './repo'
import { cacheThumb, getThumbLoadMode, setThumbLoadMode, uncacheThumb } from './thumbs'
import { scanWatchFolder } from './scanner'
import {
  DEFAULT_COMPRESS_CONFIG,
  buildArgs,
  describeEncodeArgs,
  finalPathFor,
  findFfprobe,
  needTwoPass,
  passLogPath,
  probeVideo,
  runFfmpeg,
  tempOutputPath,
  type CompressConfig,
} from './compress'
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

  /** dir 在 root 之内（含相等）。 */
  function isUnderDir(dir: string, root: string): boolean {
    const rel = path.relative(root, dir)
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  /**
   * 把 src 目录的内容合并移动到已存在的 dst：同名文件直接覆盖，子目录递归合并。
   * 同盘逐条 rename（瞬间）；跨盘回退 cp(force)+删除。
   * 返回移动失败的文件路径（如文件被占用）；成功的文件已从 src 移除。
   */
  async function mergeMoveDir(src: string, dst: string): Promise<string[]> {
    const failed: string[] = []
    await mkdir(dst, { recursive: true })
    const entries = await readdir(src, { withFileTypes: true })
    for (const entry of entries) {
      const s = path.join(src, entry.name)
      const d = path.join(dst, entry.name)
      if (entry.isDirectory()) {
        if (existsSync(d)) {
          // 目标同名子目录已存在 → 递归合并
          failed.push(...(await mergeMoveDir(s, d)))
          rmSync(s, { recursive: true, force: true }) // 内容已移走，清理空壳
        } else {
          try {
            await rename(s, d)
          } catch (e: any) {
            if (e?.code === 'EXDEV') {
              await cp(s, d, { recursive: true, force: true })
              rmSync(s, { recursive: true, force: true })
            } else throw e
          }
        }
      } else {
        // 文件：直接覆盖目标（Node 的 rename 在 Windows/POSIX 均可替换已存在文件）
        try {
          await rename(s, d)
        } catch (e: any) {
          if (e?.code === 'EXDEV') {
            await cp(s, d, { force: true })
            await unlink(s)
          } else if (e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EBUSY') {
            failed.push(s) // 目标被占用等，保留在源目录
          } else throw e
        }
      }
    }
    // 源目录内容已全部处理，删除空壳（失败的文件已被排除，rm 仅清目录）
    if (failed.length === 0) rmSync(src, { recursive: true, force: true })
    return failed
  }

  /**
   * 移动整个文件夹：磁盘移动（同盘 rename 瞬间；跨盘复制+删除，较慢），
   * 并在事务中同步更新该目录下所有视频的 path/sub_dir/folder_id 与收藏路径。
   * 目标已存在同名目录时合并移动：同名文件直接覆盖。
   */
  ipcMain.handle('dir:move', async (_e, args: { src: string; targetParent: string }) => {
    const src = path.resolve(String(args.src ?? ''))
    const targetParent = path.resolve(String(args.targetParent ?? ''))
    if (!src || !targetParent) return { ok: false as const, error: '参数缺失' }

    // 基本校验
    if (!existsSync(src) || !statSync(src).isDirectory()) return { ok: false as const, error: '源目录不存在' }
    if (!existsSync(targetParent) || !statSync(targetParent).isDirectory()) {
      return { ok: false as const, error: '目标父目录不存在' }
    }
    const name = path.basename(src)
    const dst = path.join(targetParent, name)
    if (path.resolve(dst) === path.resolve(src)) return { ok: false as const, error: '目标与源相同' }
    if (isUnderDir(targetParent, src)) return { ok: false as const, error: '目标位置不能位于源目录内部' }
    // 目标已存在同名目录 → 合并移动（同名文件覆盖），不再拒绝
    const dstExists = existsSync(dst)

    // 目标必须落在某个监控文件夹范围内（否则库中的记录将失去管理意义）
    const folders = repo.listWatchFolders(db)
    const targetFolder = folders.find((f) => isUnderDir(dst, f.path))
    if (!targetFolder) {
      return { ok: false as const, error: '目标位置不在任何监控文件夹范围内，移动后视频将无法在库中管理' }
    }

    // 受影响的视频
    const prefix = src + path.sep
    const rows = db.prepare('SELECT id, path FROM videos WHERE path LIKE ?').all(prefix + '%') as {
      id: number
      path: string
    }[]
    const crossDrive = path.parse(src).root !== path.parse(dst).root

    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['取消', '移动'],
      defaultId: 1,
      cancelId: 0,
      title: dstExists ? '移动并合并文件夹' : '移动文件夹',
      message: dstExists
        ? `目标位置已存在「${name}」，将把内容合并进去（同名文件直接覆盖）？`
        : `将移动文件夹「${name}」到：\n${targetParent}`,
      detail:
        `包含 ${rows.length} 条视频记录，移动后路径将同步更新。\n` +
        (dstExists
          ? '⚠ 合并模式：目标目录中与源同名的文件将被覆盖，目标中其他文件保持不变。\n'
          : '') +
        (crossDrive
          ? '⚠ 源与目标不在同一磁盘/挂载点，将采用「复制+删除」方式，大文件夹耗时可能很长。\n'
          : '') +
        '操作完成后自动刷新。',
    })
    if (response !== 1) return { ok: false as const, cancelled: true as const }

    // 磁盘移动
    let mergeFailed: string[] = []
    try {
      if (dstExists) {
        // 合并移动（同盘逐条 rename / 跨盘复制+删除，均在内部处理）
        mergeFailed = await mergeMoveDir(src, dst)
      } else {
        try {
          await rename(src, dst)
        } catch (e: any) {
          if (e?.code !== 'EXDEV') throw e
          // 跨盘：复制 + 删除（force 以防万一）
          await cp(src, dst, { recursive: true, force: true })
          rmSync(src, { recursive: true, force: true })
        }
      }
    } catch (e: any) {
      return { ok: false as const, error: `磁盘移动失败：${e?.message ?? String(e)}` }
    }

    // 数据库事务更新（合并模式下跳过移动失败的文件，其记录保持原路径）
    const failedSet = new Set(mergeFailed)
    const newPrefix = dst + path.sep
    let updated = 0
    try {
      db.exec('BEGIN')
      for (const row of rows) {
        if (failedSet.has(row.path)) continue // 该文件未能移动，记录保持原路径
        const newPath = newPrefix + row.path.slice(prefix.length)
        const rel = path.relative(targetFolder.path, newPath)
        const segs = rel.split(path.sep)
        const subDir = !rel.startsWith('..') && segs.length > 1 ? segs[0] : null
        db.prepare('UPDATE videos SET path = ?, sub_dir = ?, folder_id = ? WHERE id = ?').run(
          newPath,
          subDir,
          targetFolder.id,
          row.id,
        )
        updated++
      }
      // 收藏路径同步（前缀替换）
      const favs = getFavoriteDirs()
      const favList = [...favs]
      const newFavs = favList.map((p) => (p.startsWith(prefix) ? newPrefix + p.slice(prefix.length) : p))
      if (newFavs.some((p, i) => p !== favList[i])) {
        repo.setSetting(db, 'favoriteDirs', JSON.stringify(newFavs))
      }
      db.exec('COMMIT')
    } catch (e: any) {
      db.exec('ROLLBACK')
      return { ok: false as const, error: `数据库更新失败：${e?.message ?? String(e)}` }
    }

    if (mergeFailed.length > 0) {
      const names = mergeFailed.slice(0, 3).map((p) => path.basename(p)).join('、')
      return {
        ok: true as const,
        moved: updated,
        dst,
        partial: true as const,
        error: `${mergeFailed.length} 个文件未能移动（可能被占用）：${names}${mergeFailed.length > 3 ? '…' : ''}`,
      }
    }
    return { ok: true as const, moved: updated, dst }
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

  // ---------- 缩略图加载模式 ----------
  ipcMain.handle('thumbs:getMode', () => getThumbLoadMode(db))
  ipcMain.handle('thumbs:setMode', (_e, mode: 'eager' | 'lazy') => setThumbLoadMode(db, mode))

  // ---------- 视频压缩 ----------

  function loadCompressConfig(): CompressConfig {
    try {
      const j = JSON.parse(repo.getSetting(db, 'compressConfig') ?? 'null')
      if (j && typeof j === 'object') return { ...DEFAULT_COMPRESS_CONFIG, ...j }
    } catch {
      // 配置损坏则回落默认
    }
    return { ...DEFAULT_COMPRESS_CONFIG }
  }

  ipcMain.handle('compress:getConfig', () => loadCompressConfig())
  ipcMain.handle('compress:setConfig', (_e, cfg: CompressConfig) => {
    repo.setSetting(db, 'compressConfig', JSON.stringify({ ...DEFAULT_COMPRESS_CONFIG, ...cfg }))
  })

  // 压缩任务队列：串行执行（编码极耗 CPU/GPU，并发反而更慢）
  let queue: { id: number; path: string; filename: string }[] = []
  let running = false
  let cancelled = false
  let currentCancel: (() => void) | null = null

  function pushCompressProgress(p: Record<string, unknown>): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('compress:progress', p)
  }

  /** 压缩单个视频并替换原文件；返回处理结果。 */
  async function compressOne(
    ffmpeg: string,
    ffprobe: string | null,
    item: { id: number; path: string; filename: string },
    cfg: CompressConfig,
  ): Promise<{ ok: boolean; skipped?: boolean; error?: string; oldSize?: number; newSize?: number }> {
    const tmpOut = tempOutputPath(item.path)
    const pLog = passLogPath(tmpOut)
    try {
      const info = await probeVideo(ffmpeg, ffprobe, item.path)
      if (!info.duration) return { ok: false, error: '无法读取视频时长' }

      const twoPass = needTwoPass(cfg)
      const passes = twoPass ? [1, 2] : [0]
      for (const passNo of passes) {
        // 两遍编码：分析占 0~50%，编码占 50~100%
        const base = twoPass ? (passNo === 1 ? 0 : 50) : 0
        const span = twoPass ? 50 : 100
        const args = buildArgs(item.path, tmpOut, info, cfg, passNo, pLog)
        const { promise, cancel } = runFfmpeg(ffmpeg, args, info.duration, (p) => {
          pushCompressProgress({
            videoId: item.id,
            filename: item.filename,
            percent: Math.min(100, base + (p.percent / 100) * span),
            speed: p.speed,
            outSize: p.outSize,
            stage: twoPass ? (passNo === 1 ? '分析 1/2' : '编码 2/2') : '压缩中',
          })
        })
        currentCancel = cancel
        const { code, error } = await promise
        currentCancel = null
        if (cancelled) {
          rmSync(tmpOut, { force: true })
          return { ok: false, error: '已取消' }
        }
        if (code !== 0) {
          rmSync(tmpOut, { force: true })
          return { ok: false, error: (error || 'ffmpeg 执行失败').trim().slice(-300) }
        }
      }

      // 清理两遍编码的临时日志
      for (const junk of [`${pLog}-0.log`, `${pLog}-0.log.mbtree`]) {
        try { rmSync(junk, { force: true }) } catch { /* 忽略 */ }
      }

      if (!existsSync(tmpOut)) return { ok: false, error: '未生成输出文件' }

      const newStat = await stat(tmpOut)
      const oldStat = await stat(item.path)
      // 体积保护：默认仅当新文件更小时才替换，避免"越压越大"
      if (cfg.onlyIfSmaller && newStat.size >= oldStat.size) {
        rmSync(tmpOut, { force: true })
        return { ok: true, skipped: true, oldSize: oldStat.size, newSize: newStat.size }
      }

      // 用新文件替换原文件：删除原文件 → 重命名新文件为最终名
      const finalPath = finalPathFor(item.path)
      await unlink(item.path)
      await rename(tmpOut, finalPath)

      // 更新数据库：路径/文件名可能变化（统一为 .mp4），体积与修改时间同步刷新
      const fStat = await stat(finalPath)
      db.prepare(`
        UPDATE videos SET path = ?, filename = ?, size_bytes = ?, mtime = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(finalPath, path.basename(finalPath), fStat.size, Math.floor(fStat.mtimeMs), item.id)
      // 缩略图 BLOB 内容仍对应同一画面，保留即可

      return { ok: true, oldSize: oldStat.size, newSize: fStat.size }
    } catch (e: any) {
      try { rmSync(tmpOut, { force: true }) } catch { /* 忽略 */ }
      return { ok: false, error: e?.message ?? String(e) }
    }
  }

  /** 后台串行处理压缩队列，完成后广播汇总。 */
  async function drainCompressQueue(ffmpeg: string, ffprobe: string | null, cfg: CompressConfig): Promise<void> {
    if (running) return
    running = true
    const total = queue.length
    let done = 0
    let okCount = 0
    let skipCount = 0
    const failed: { filename: string; error: string }[] = []
    let savedBytes = 0

    while (queue.length > 0 && !cancelled) {
      const item = queue.shift()!
      // remaining：尚未开始处理的文件名（供前端显示剩余队列）
      const remaining = queue.map((q) => q.filename)
      pushCompressProgress({
        videoId: item.id, filename: item.filename, percent: 0, speed: '', outSize: 0,
        stage: '准备中', current: done + 1, total, remaining,
      })
      const r = await compressOne(ffmpeg, ffprobe, item, cfg)
      done++
      if (r.skipped) {
        skipCount++
      } else if (r.ok) {
        okCount++
        savedBytes += Math.max(0, (r.oldSize ?? 0) - (r.newSize ?? 0))
      } else {
        failed.push({ filename: item.filename, error: r.error ?? '未知错误' })
      }
      pushCompressProgress({
        videoId: item.id, filename: item.filename, percent: 100, speed: '', outSize: r.newSize ?? 0,
        stage: r.skipped ? '已跳过（未变小）' : r.ok ? '完成' : '失败', current: done, total,
        remaining: queue.map((q) => q.filename),
      })
    }

    queue = []
    running = false
    const wasCancelled = cancelled
    cancelled = false
    currentCancel = null
    pushCompressProgress({
      finished: true,
      cancelled: wasCancelled,
      ok: okCount,
      skipped: skipCount,
      failed,
      savedBytes,
      total,
    })
  }

  ipcMain.handle('compress:start', async (_e, videos: { id: number; path: string; filename: string }[]) => {
    const ffmpeg = repo.getSetting(db, 'ffmpegPath')
    if (!ffmpeg) {
      await dialog.showMessageBox({
        type: 'warning', title: '未配置 FFmpeg',
        message: '未配置 FFmpeg 路径，无法压缩视频。',
        detail: '请在右上角「设置」中填写 FFmpeg 可执行文件路径。',
      })
      return { started: false }
    }
    const list = (videos ?? []).filter((v) => Number.isInteger(v.id) && v.path)
    if (list.length === 0) return { started: false }

    const cfg = loadCompressConfig()
    const enc = describeEncodeArgs(cfg)
    const qualityLabel = { high: '高画质', balanced: '均衡', small: '更小体积' }[cfg.quality]
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['取消', '开始压缩'],
      defaultId: 1,
      cancelId: 0,
      title: '压缩视频（将替换原文件）',
      message: `将压缩 ${list.length} 个视频并用新文件替换原文件，是否继续？`,
      detail:
        `${cfg.codec === 'hevc' ? 'H.265' : cfg.codec === 'h264' ? 'H.264' : 'AV1'} / ` +
        `${cfg.mode === 'crf' ? qualityLabel : `目标 ${cfg.targetMB}MB`} / ` +
        `${cfg.useGpu ? '显卡加速' : 'CPU'}\n` +
        `编码器：${enc.encoder}\n` +
        `参数：${enc.args}\n` +
        (cfg.mode === 'size' && cfg.useGpu ? '（注：NVENC 不支持两遍编码，目标大小模式下退化为单遍）\n' : '') +
        '\n压缩在后台进行，可继续使用软件。完成后原文件会被删除，替换为压缩后的文件。\n' +
        '提示：压缩是有损的，建议确认重要视频已备份。',
    })
    if (response !== 1) return { started: false }

    queue = list
    cancelled = false
    const ffprobe = await findFfprobe(ffmpeg)
    void drainCompressQueue(ffmpeg, ffprobe, cfg) // 后台执行，不阻塞界面
    return { started: true, count: list.length }
  })

  ipcMain.handle('compress:cancel', () => {
    if (!running) return
    cancelled = true
    try { currentCancel?.() } catch { /* 忽略 */ }
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

  /**
   * 一键补全媒体信息：合并「生成缩略图」与「读取时长」，按缺失情况处理：
   * - 都有 → 跳过；只有缩略图 → 补时长；只有时长 → 补缩略图；都没有 → 两个都做
   * - 时长只探测一次，抽帧复用该结果（不重复读取文件，IO 减半）
   * - 4 路并发（SMB 场景并发过高反而变慢），带进度推送
   */
  ipcMain.handle('ffmpeg:batchMedia', async (e, videos: { id: number; path: string }[]) => {
    const ffmpeg = repo.getSetting(db, 'ffmpegPath')
    if (!ffmpeg) {
      await dialog.showMessageBox({
        type: 'warning',
        title: '未配置 FFmpeg',
        message: '未配置 FFmpeg 路径，无法补全缩略图与时长。',
        detail: '请在右上角「设置」中填写 FFmpeg 可执行文件路径。',
      })
      return { cancelled: true, ok: 0, skipped: 0, failed: [] }
    }

    // 预检：逐个判断缺什么，统计待处理项
    type Task = { id: number; path: string; needThumb: boolean; needRuntime: boolean }
    const tasks: Task[] = []
    for (const v of videos) {
      const row = db.prepare(`
        SELECT v.runtime AS runtime, v.thumb_path AS thumb_path,
          EXISTS (SELECT 1 FROM video_thumbs t WHERE t.video_id = v.id) AS has_blob
        FROM videos v WHERE v.id = ?
      `).get(v.id) as
        | { runtime: number | null; thumb_path: string | null; has_blob: number }
        | undefined
      if (!row) continue
      const needRuntime = !(row.runtime != null && row.runtime > 0)
      const needThumb = !(row.has_blob || row.thumb_path)
      if (!needRuntime && !needThumb) continue // 两样都有 → 跳过
      tasks.push({ id: v.id, path: v.path, needThumb, needRuntime })
    }

    const total = tasks.length
    if (total === 0) {
      await dialog.showMessageBox({
        type: 'info',
        title: '无需处理',
        message: '所选视频都已具备缩略图与时长信息。',
        detail: '只有缺少其中任一项的视频才会被处理。',
      })
      return { cancelled: true, ok: 0, skipped: videos.length, failed: [] }
    }

    const needThumbCount = tasks.filter((t) => t.needThumb).length
    const needRuntimeCount = tasks.filter((t) => t.needRuntime).length
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['取消', '确认处理'],
      defaultId: 1,
      cancelId: 0,
      title: '一键补全信息',
      message: `将为 ${total} 个视频补全缺失的信息，是否继续？`,
      detail:
        `需生成缩略图：${needThumbCount} 个\n需读取时长：${needRuntimeCount} 个\n` +
        `已完整的 ${videos.length - total} 个视频将被跳过。\n\n` +
        '缩略图以 BLOB 存入数据库；时长用 FFmpeg 读取（与刮削无关，适用于无 NFO 的视频）。\n' +
        '两项都缺的视频只探测一次时长，抽帧复用该结果。耗时取决于视频数量与磁盘/网络速度。',
    })
    if (response !== 1) return { cancelled: true, ok: 0, skipped: videos.length - total, failed: [] }

    const CONCURRENCY = 4
    const failed: { id: number; path: string; error: string }[] = []
    let ok = 0
    let done = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = done++
        if (i >= total) return
        const t = tasks[i]
        e.sender.send('ffmpeg:batchMedia:progress', { done: i, total, current: path.basename(t.path) })
        try {
          // 时长：缺就探测一次；不缺但需抽帧时也要探测（抽帧需定位中间位置）
          let sec = 0
          if (t.needRuntime || t.needThumb) {
            sec = await probeDurationSec(ffmpeg, t.path)
            if (t.needRuntime) {
              if (sec > 0) {
                db.prepare("UPDATE videos SET runtime = ?, updated_at = datetime('now') WHERE id = ?").run(
                  Math.round((sec / 60) * 100) / 100,
                  t.id,
                )
              } else {
                failed.push({ id: t.id, path: t.path, error: '无法读取时长（文件损坏或编码不支持）' })
              }
            }
          }

          if (t.needThumb) {
            // 磁盘上已有缩略图文件（旧版文件式 / NFO 自带）→ 直接读入导入 BLOB，零 ffmpeg 开销
            const pRow = db.prepare('SELECT thumb_path FROM videos WHERE id = ?').get(t.id) as
              | { thumb_path: string | null }
              | undefined
            let imported = false
            if (pRow?.thumb_path && existsSync(pRow.thumb_path)) {
              try {
                const data = await readFile(pRow.thumb_path)
                const mime = /\.png$/i.test(pRow.thumb_path)
                  ? 'image/png'
                  : /\.webp$/i.test(pRow.thumb_path)
                    ? 'image/webp'
                    : 'image/jpeg'
                repo.setThumbBlob(db, t.id, data, mime)
                cacheThumb(t.id, { data, mime })
                imported = true
              } catch {
                // 读取失败 → 回落到 ffmpeg 抽帧
              }
            }
            if (!imported) {
              if (sec <= 0) {
                // probe 已失败过（且 needRuntime 时已记入 failed），这里补记避免漏报
                if (!t.needRuntime) failed.push({ id: t.id, path: t.path, error: '无法读取视频时长' })
              } else {
                const r = await captureThumbBlob(ffmpeg, t.id, t.path, sec / 2)
                if (!r.ok) failed.push({ id: t.id, path: t.path, error: r.error ?? '抽帧失败' })
              }
            }
          }
          ok++
        } catch (err: any) {
          failed.push({ id: t.id, path: t.path, error: err?.message ?? String(err) })
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, total) }, worker))
    e.sender.send('ffmpeg:batchMedia:progress', { done: total, total, current: '' })
    return { cancelled: false, ok, skipped: videos.length - total, failed }
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
  /** 删除单个视频的磁盘文件（视频+NFO+缩略图）、库记录与内存缓存。不弹确认框，供单个/批量复用。 */
  function removeVideoCompletely(row: repo.VideoRow): { failed: string[] } {
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

    db.prepare('DELETE FROM videos WHERE id = ?').run(row.id)
    uncacheThumb(row.id) // video_thumbs 由外键级联删除，同步移除内存缓存
    return { failed }
  }

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

    const { failed } = removeVideoCompletely(row)
    if (failed.length > 0) {
      return { ok: true as const, partial: true as const, failed }
    }
    return { ok: true as const }
  })

  // 批量删除：一次确认（避免逐个弹窗），逐个彻底删除并汇总失败项
  ipcMain.handle('video:deleteMany', async (_e, ids: number[]) => {
    const list = (ids ?? []).filter((n) => Number.isInteger(n))
    if (list.length === 0) return { ok: false as const, error: '未选择任何视频' }

    const rows: repo.VideoRow[] = []
    for (const id of list) {
      const row = db.prepare('SELECT * FROM videos WHERE id = ?').get(id) as repo.VideoRow | undefined
      if (row) rows.push(row)
    }
    if (rows.length === 0) return { ok: false as const, error: '所选视频均不存在（可能已删除）' }

    const preview = rows.slice(0, 6).map((r) => r.filename).join('\n')
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['取消', `彻底删除 ${rows.length} 个`],
      defaultId: 0,
      cancelId: 0,
      title: '批量删除影片（不可恢复）',
      message: `确定要从硬盘彻底删除这 ${rows.length} 个视频？`,
      detail:
        `${preview}${rows.length > 6 ? `\n…等共 ${rows.length} 个` : ''}\n\n` +
        '此操作将直接删除文件（含同名 NFO 与缩略图），不经过回收站，且无法恢复！',
    })
    if (response !== 1) return { ok: false as const, cancelled: true as const }

    const failed: string[] = []
    for (const row of rows) {
      const r = removeVideoCompletely(row)
      if (r.failed.length > 0) failed.push(`${row.filename}（${r.failed.join('；')}）`)
    }
    return { ok: true as const, deleted: rows.length, failed }
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
