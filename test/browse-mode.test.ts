import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openLibraryDb } from '../electron/main/library/db'
import { addWatchFolder, ensureTag, listWatchFolders, setWatchFolderMode } from '../electron/main/library/repo'

let root: string
const db = openLibraryDb(':memory:')

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'videolib-mode-test-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('browse_mode', () => {
  it('新增文件夹默认 tree，可切换到 actor', () => {
    const id = addWatchFolder(db, root, '测试库', ensureTag(db, '测试'))
    let folder = listWatchFolders(db).find((f) => f.id === id)!
    expect(folder.browse_mode).toBe('tree')

    setWatchFolderMode(db, id, 'actor')
    folder = listWatchFolders(db).find((f) => f.id === id)!
    expect(folder.browse_mode).toBe('actor')

    setWatchFolderMode(db, id, 'tree')
    folder = listWatchFolders(db).find((f) => f.id === id)!
    expect(folder.browse_mode).toBe('tree')
  })

  it('旧库迁移：watch_folders 缺 browse_mode 列时自动补列，默认 tree', () => {
    const file = join(root, 'legacy.db')
    const raw = new DatabaseSync(file)
    raw.exec(`
      CREATE TABLE watch_folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        tag_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    raw.close()

    const migrated = openLibraryDb(file)
    const cols = migrated.prepare('PRAGMA table_info(watch_folders)').all() as { name: string }[]
    expect(cols.some((c) => c.name === 'browse_mode')).toBe(true)
    migrated.close()
  })
})
