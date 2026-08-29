import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openLibraryDb } from '../electron/main/library/db'
import { addWatchFolder, ensureTag, listWatchFolders } from '../electron/main/library/repo'
import { scanWatchFolder } from '../electron/main/library/scanner'

const dbPath = resolve(process.env.APPDATA ?? '', 'videolib', 'videolib.db')
const demoPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'demo-lib')

const db = openLibraryDb(dbPath)
const existing = listWatchFolders(db).find((f) => f.path === demoPath)
const id = existing?.id ?? addWatchFolder(db, demoPath, '演示库', ensureTag(db, '演示'))
const summary = await scanWatchFolder(db, { id, path: demoPath, tagName: '演示' })
console.log('seeded:', summary)
db.close()
