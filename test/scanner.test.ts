import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openLibraryDb } from '../electron/main/library/db'
import { addWatchFolder, ensureTag, getVideoByPath, listFolderVideoPaths } from '../electron/main/library/repo'
import { scanWatchFolder } from '../electron/main/library/scanner'

let root: string
let folderId: number
const db = openLibraryDb(':memory:')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'videolib-test-'))
  const workDir = join(root, '佐山爱', 'JUFE-188')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(root, '未整理'), { recursive: true })

  copyFileSync(join(__dirname, 'fixtures', 'JUFE-188-C.nfo'), join(workDir, 'JUFE-188-C.nfo'))
  writeFileSync(join(workDir, 'JUFE-188-C.mp4'), 'fake-video-content')
  writeFileSync(join(workDir, 'poster.jpg'), 'fake-jpg')
  writeFileSync(join(workDir, 'fanart.jpg'), 'fake-jpg')
  writeFileSync(join(root, '未整理', '随手拍的视频.mp4'), 'fake-video-content-2')

  folderId = addWatchFolder(db, root, '有码', ensureTag(db, '有码'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanWatchFolder', () => {
  it('首次扫描入库，NFO 元数据、演员、标签、封面全部就位', async () => {
    const summary = await scanWatchFolder(db, { id: folderId, path: root, tagName: '有码' })
    expect(summary.scanned).toBe(2)
    expect(summary.added).toBe(2)

    const video = getVideoByPath(db, join(root, '佐山爱', 'JUFE-188', 'JUFE-188-C.mp4'))!
    expect(video.num).toBe('JUFE-188')
    expect(video.part).toBe('c')
    expect(video.has_nfo).toBe(1)
    expect(video.title).toContain('JUFE-188')
    expect(video.studio).toBe('Fitch')
    expect(video.sub_dir).toBe('佐山爱')
    expect(video.poster_path?.endsWith('poster.jpg')).toBe(true)
    expect(video.fanart_path?.endsWith('fanart.jpg')).toBe(true)
    expect(video.thumb_path).toBeNull()

    const tags = db.prepare(`
      SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ? ORDER BY t.name
    `).all(video.id) as { name: string }[]
    const tagNames = tags.map((t) => t.name)
    expect(tagNames).toContain('有码')
    expect(tagNames).toContain('巨乳')

    const actors = db.prepare(`
      SELECT a.name FROM video_actors va JOIN actors a ON a.id = va.actor_id WHERE va.video_id = ?
    `).all(video.id) as { name: string }[]
    expect(actors.map((a) => a.name)).toEqual(['佐山爱'])
  })

  it('无 NFO 的视频只挂一级文件夹标签', async () => {
    const video = getVideoByPath(db, join(root, '未整理', '随手拍的视频.mp4'))!
    expect(video.has_nfo).toBe(0)
    expect(video.num).toBeNull()
    expect(video.sub_dir).toBe('未整理')

    const tags = db.prepare(`
      SELECT t.name FROM video_tags vt JOIN tags t ON t.id = vt.tag_id WHERE vt.video_id = ?
    `).all(video.id) as { name: string }[]
    expect(tags.map((t) => t.name)).toEqual(['有码'])
  })

  it('重复扫描不产生变化', async () => {
    const summary = await scanWatchFolder(db, { id: folderId, path: root, tagName: '有码' })
    expect(summary).toEqual({ scanned: 2, added: 0, updated: 0, removed: 0 })
    expect(listFolderVideoPaths(db, folderId)).toHaveLength(2)
  })

  it('文件删除后记录被移除', async () => {
    rmSync(join(root, '未整理', '随手拍的视频.mp4'))
    const summary = await scanWatchFolder(db, { id: folderId, path: root, tagName: '有码' })
    expect(summary.removed).toBe(1)
    expect(listFolderVideoPaths(db, folderId)).toHaveLength(1)
  })
})
