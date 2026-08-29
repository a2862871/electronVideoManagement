import { DatabaseSync } from 'node:sqlite'

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS watch_folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tag_id INTEGER REFERENCES tags(id) ON DELETE SET NULL,
  browse_mode TEXT NOT NULL DEFAULT 'tree',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT
);

CREATE TABLE IF NOT EXISTS videos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id INTEGER NOT NULL REFERENCES watch_folders(id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  num TEXT,
  part TEXT,
  title TEXT,
  originaltitle TEXT,
  plot TEXT,
  releasedate TEXT,
  runtime INTEGER,
  studio TEXT,
  series TEXT,
  rating REAL,
  sub_dir TEXT,
  poster_path TEXT,
  fanart_path TEXT,
  thumb_path TEXT,
  has_nfo INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER,
  mtime INTEGER,
  play_position_sec INTEGER NOT NULL DEFAULT 0,
  play_updated_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id);
CREATE INDEX IF NOT EXISTS idx_videos_num ON videos(num);
CREATE INDEX IF NOT EXISTS idx_videos_sub_dir ON videos(sub_dir);

CREATE TABLE IF NOT EXISTS actors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  alias TEXT
);

CREATE TABLE IF NOT EXISTS video_actors (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, actor_id)
);

CREATE TABLE IF NOT EXISTS video_tags (
  video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (video_id, tag_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 抽帧生成的缩略图以 BLOB 存库（一次加载进内存，随视频删除级联清理）。
-- videos.thumb_path 仅保留给 NFO 自带的磁盘图片；展示时 BLOB 优先。
CREATE TABLE IF NOT EXISTS video_thumbs (
  video_id INTEGER PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
  data BLOB NOT NULL,
  mime TEXT NOT NULL DEFAULT 'image/jpeg',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

export function openLibraryDb(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/** 对旧库做增量迁移：CREATE TABLE IF NOT EXISTS 不会改已有表结构。 */
function migrate(db: DatabaseSync): void {
  const cols = db.prepare('PRAGMA table_info(watch_folders)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'browse_mode')) {
    db.exec("ALTER TABLE watch_folders ADD COLUMN browse_mode TEXT NOT NULL DEFAULT 'tree'")
  }
  const actorCols = db.prepare('PRAGMA table_info(actors)').all() as { name: string }[]
  if (!actorCols.some((c) => c.name === 'alias')) {
    db.exec('ALTER TABLE actors ADD COLUMN alias TEXT')
  }
}
