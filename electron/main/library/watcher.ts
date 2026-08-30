import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import * as repo from './repo'
import { scanWatchFolder } from './scanner'

/**
 * 监控文件夹变更监听 + 自动扫描入库。
 *
 * 关键：新文件必须经 scanWatchFolder 写入 videos 表才会出现在视频列表里；
 * 只刷新界面（重查数据库）是无效的。因此变更事件去抖后会**自动执行一次扫描**，
 * 而不仅仅是广播刷新。
 *
 * - 事件驱动：fs.watch 递归监听监控文件夹根，平时零轮询零 IO
 * - 增量扫描：只扫发生变化的目录（能定位时），避免每次全量遍历
 * - 聚焦兜底：SMB 挂载可能漏掉部分事件，切回窗口时（节流）补扫一次
 */

let dbRef: DatabaseSync | null = null
let watchers: FSWatcher[] = []
let broadcast: (() => void) | null = null

/** 去抖计时器 */
let timer: NodeJS.Timeout | null = null
/** 待扫描的目录集合 */
const pending = new Set<string>()
let scanning = false
let lastScanAt = 0

const DEBOUNCE_MS = 2500 // 事件去抖：连续复制多个文件合并为一次扫描
const MIN_SCAN_INTERVAL_MS = 5000 // 聚焦兜底的最小间隔，避免频繁全量扫

/** 自动扫描开关（settings.autoScan，默认开启）。 */
function isAutoScanEnabled(): boolean {
  if (!dbRef) return false
  return repo.getSetting(dbRef, 'autoScan') !== '0'
}

function isUnder(dir: string, root: string): boolean {
  const rel = path.relative(root, dir)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function scheduleScan(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void runScan()
  }, DEBOUNCE_MS)
}

/** 对发生变化的目录执行扫描入库，完成后广播前端刷新。 */
export async function runScan(): Promise<void> {
  const db = dbRef
  if (!db || scanning) return
  scanning = true
  try {
    const folders = repo.listWatchFolders(db)
    let changed = 0
    for (const folder of folders) {
      const tag = folder.tag_id
        ? (db.prepare('SELECT name FROM tags WHERE id = ?').get(folder.tag_id) as { name: string } | undefined)
        : undefined
      // 只扫落在该监控文件夹内的变化目录；无变化信息时（如聚焦触发）退回扫描整个根
      const dirs = [...pending].filter((d) => isUnder(d, folder.path))
      const targets = pending.size === 0 ? [folder.path] : dirs
      for (const t of targets) {
        const s = await scanWatchFolder(db, { id: folder.id, path: t, rootPath: folder.path, tagName: tag?.name ?? null })
        changed += s.added + s.updated + s.removed
      }
    }
    pending.clear()
    lastScanAt = Date.now()
    // 只有数据真的变化了才通知前端刷新：避免聚焦/恢复窗口时列表无谓重渲染（表现为页面"闪一下"）
    if (changed > 0) broadcast?.()
  } catch {
    // 扫描失败（如目录临时不可访问）忽略，下次事件或聚焦再试
  } finally {
    scanning = false
    // 扫描期间又发生变化 → 再排一次，避免漏更新
    if (pending.size > 0) scheduleScan()
  }
}

/**
 * 窗口聚焦时调用：按节流补扫一次（SMB 事件兜底）。
 * 注意：这里**不主动刷新界面**——聚焦（含最小化后恢复）不该触发列表重渲染，
 * 只有在扫描确实发现变化时才由 runScan 通知刷新。
 */
export function triggerScanOnFocus(): void {
  if (!isAutoScanEnabled()) return
  if (Date.now() - lastScanAt < MIN_SCAN_INTERVAL_MS) return
  void runScan()
}

/** 启动对所有监控文件夹根的递归监听；返回停止函数。 */
export function startFolderWatcher(db: DatabaseSync, onChanged: () => void): () => void {
  stopFolderWatcher()
  dbRef = db
  broadcast = onChanged
  const folders = repo.listWatchFolders(db)
  for (const f of folders) {
    try {
      const w = watch(f.path, { recursive: true }, (_event, filename) => {
        // 关闭自动扫描时，仅刷新界面（等同旧行为）
        if (!isAutoScanEnabled()) {
          broadcast?.()
          return
        }
        if (filename) {
          const full = path.isAbsolute(filename) ? filename : path.join(f.path, filename)
          pending.add(path.dirname(full))
        } else {
          pending.add(f.path)
        }
        scheduleScan()
      })
      w.on('error', () => {
        // SMB 断连等场景下 watcher 会报错，忽略即可（聚焦兜底仍会扫描）
      })
      watchers.push(w)
    } catch {
      // 目录不存在 / 无权限 → 跳过该目录的监听
    }
  }
  return stopFolderWatcher
}

/** 停止并释放所有 watcher。 */
export function stopFolderWatcher(): void {
  for (const w of watchers) {
    try { w.close() } catch { /* 忽略 */ }
  }
  watchers = []
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  pending.clear()
}
