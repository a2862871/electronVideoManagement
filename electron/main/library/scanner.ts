import { accessSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { fileStem, parseFilename } from './filename'
import { parseNfo } from './nfo'
import * as repo from './repo'

export const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.mkv', '.avi', '.wmv', '.mov', '.flv', '.ts', '.m4v', '.rmvb', '.webm',
])
const ART_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp']
const ART_KINDS = ['poster', 'fanart', 'thumb'] as const

export interface ScanTarget {
  id: number
  /** 实际扫描的路径（可能是监控文件夹根，也可能是其下某个子目录） */
  path: string
  /** 监控文件夹根路径，用于 sub_dir 计算（缺省用 path） */
  rootPath?: string
  tagName: string | null
}

export interface ScanSummary {
  scanned: number
  added: number
  updated: number
  removed: number
}

async function* walk(dir: string): AsyncGenerator<string> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile()) {
      yield full
    }
  }
}

function findArt(dir: string, kind: string, num: string | undefined, stem: string): string | null {
  const candidates: string[] = []
  if (num) candidates.push(`${num}-${kind}`)
  candidates.push(kind, `${stem}-${kind}`)
  for (const base of candidates) {
    for (const ext of ART_EXTENSIONS) {
      const full = path.join(dir, base + ext)
      try {
        accessSync(full)
        return full
      } catch {
        // 尝试下一个候选名
      }
    }
  }
  return null
}

function firstSubDir(root: string, filePath: string): string | null {
  const rel = path.relative(root, filePath)
  const seg = rel.split(path.sep)
  return seg.length > 1 ? seg[0] : null
}

export async function scanWatchFolder(db: DatabaseSync, target: ScanTarget): Promise<ScanSummary> {
  const summary: ScanSummary = { scanned: 0, added: 0, updated: 0, removed: 0 }
  const folderTagId = target.tagName ? repo.ensureTag(db, target.tagName) : null
  const seen = new Set<string>()

  for await (const file of walk(target.path)) {
    const ext = path.extname(file).toLowerCase()
    if (!VIDEO_EXTENSIONS.has(ext)) continue
    summary.scanned++
    seen.add(file)

    const filename = path.basename(file)
    const stem = fileStem(filename)
    const dir = path.dirname(file)
    const fileStat = await stat(file)
    const size = fileStat.size
    const mtime = Math.floor(fileStat.mtimeMs)

    const nfoPath = path.join(dir, stem + '.nfo')
    let nfoExists = false
    let nfo
    try {
      nfo = parseNfo(await readFile(nfoPath, 'utf-8'))
      nfoExists = nfo !== undefined
    } catch {
      nfo = undefined
    }

    const fromFilename = parseFilename(stem)
    const num = nfo?.num ?? fromFilename.num
    const numMatches = fromFilename.num && num && fromFilename.num.toLowerCase() === num.toLowerCase()
    const part = nfo?.num ? (numMatches ? fromFilename.part : undefined) : fromFilename.part

    const art = {
      poster_path: findArt(dir, 'poster', num, stem),
      fanart_path: findArt(dir, 'fanart', num, stem),
      thumb_path: findArt(dir, 'thumb', num, stem),
    }
    const subDir = firstSubDir(target.rootPath ?? target.path, file)

    const existing = repo.getVideoByPath(db, file)
    if (!existing) {
      const id = repo.insertVideo(db, {
        folder_id: target.id, path: file, filename,
        num, part, size_bytes: size, mtime, sub_dir: subDir,
        has_nfo: nfoExists ? 1 : 0, ...art,
      })
      if (nfo) {
        repo.applyNfoMetadata(db, id, nfo)
        repo.setVideoActors(db, id, nfo.actors.map((a) => repo.ensureActor(db, a)))
        const tagIds = nfo.tags.map((t) => repo.ensureTag(db, t))
        if (folderTagId) tagIds.push(folderTagId)
        repo.addVideoTags(db, id, tagIds)
      } else if (folderTagId) {
        repo.addVideoTags(db, id, [folderTagId])
      }
      summary.added++
      continue
    }

    const unchanged = existing.size_bytes === size && existing.mtime === mtime && existing.has_nfo === (nfoExists ? 1 : 0)
    if (unchanged) continue

    repo.updateVideoFileState(db, existing.id, { size_bytes: size, mtime, sub_dir: subDir, ...art })
    if (nfo && !existing.has_nfo) {
      repo.applyNfoMetadata(db, existing.id, nfo)
      repo.setVideoActors(db, existing.id, nfo.actors.map((a) => repo.ensureActor(db, a)))
      const tagIds = nfo.tags.map((t) => repo.ensureTag(db, t))
      if (folderTagId) tagIds.push(folderTagId)
      repo.addVideoTags(db, existing.id, tagIds)
    }
    summary.updated++
  }

  // 只清理本次扫描范围内（target.path 前缀）的旧记录，避免误删范围外的视频
  const prefix = target.path.replace(/[\\/]+$/, '') + path.sep
  for (const oldPath of repo.listFolderVideoPaths(db, target.id)) {
    if (!oldPath.startsWith(prefix)) continue
    if (!seen.has(oldPath)) {
      const row = repo.getVideoByPath(db, oldPath)
      if (row) repo.deleteVideo(db, row.id)
      summary.removed++
    }
  }

  return summary
}
