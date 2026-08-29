export interface VideoDto {
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
  /** 数据库 BLOB 缩略图版本号（updated_at 秒级时间戳）；0 = 无 BLOB */
  thumb_blob_ver: number
  has_nfo: number
  size_bytes: number | null
  mtime: number | null
  play_position_sec: number
  play_updated_at: string | null
}

export interface VideoDetailDto extends VideoDto {
  actors: string[]
  tags: string[]
}

export interface WatchFolderDto {
  id: number
  path: string
  name: string
  tagName: string | null
  /** 浏览模式：tree=目录树分栏；actor=按演员浏览 */
  browseMode: 'tree' | 'actor'
}

export interface TagDto {
  id: number
  name: string
  count: number
}

export interface ActorDto {
  id: number
  name: string
  /** 曾用名，多个用逗号分隔（可空） */
  alias: string | null
  count: number
  /** 是否被收藏（收藏演员在演员栏置顶并显示星标） */
  favorite: boolean
}

export interface VideoQuery {
  search?: string
  /** 多标签筛选：同时包含这些标签的视频（AND 语义） */
  tagIds?: number[]
  actorId?: number
  folderId?: number
  subDir?: string
  dirPath?: string
  /** 排序：newest=按添加时间倒序（默认）；oldest=按添加时间正序 */
  sort?: 'newest' | 'oldest'
  limit?: number
  offset?: number
}

export interface DirEntryDto {
  name: string
  path: string
  count: number
  /** 是否被收藏（收藏的目录在目录栏排最前并显示星标） */
  favorite: boolean
}

export interface VideoPageDto {
  total: number
  rows: VideoDto[]
}

export interface ScanSummaryDto {
  folderId: number
  scanned: number
  added: number
  updated: number
  removed: number
}

export interface VideoUpdateArgs {
  id: number
  title?: string
  num?: string
  part?: string
  sub_dir?: string
  plot?: string
  releasedate?: string
  studio?: string
  series?: string
  rating?: number
  originaltitle?: string
  runtime?: number
  actorNames?: string[]
  tagNames?: string[]
}

/** 批量编辑参数：仅提交勾选的字段；actor/tag 支持「替换」或「追加」模式 */
export interface BatchUpdateArgs {
  ids: number[]
  sub_dir?: string
  studio?: string
  series?: string
  releasedate?: string
  rating?: number
  /** 追加模式：不覆盖已有演员，仅补充缺失的 */
  addActors?: string[]
  /** 追加模式：不覆盖已有标签，仅补充缺失的 */
  addTags?: string[]
  /** 替换模式：整体替换演员列表 */
  setActors?: string[]
  /** 替换模式：整体替换标签列表 */
  setTags?: string[]
}

export interface GrabFrameResult {
  ok: boolean
  error?: string
}

export interface BatchThumbItem {
  id: number
  path: string
}

export interface BatchThumbResult {
  cancelled: boolean
  ok: number
  /** 已有缩略图被跳过的数量 */
  skipped: number
  failed: { id: number; path: string; error: string }[]
}

export interface BatchThumbProgress {
  /** 已完成数量 */
  done: number
  /** 总数 */
  total: number
  /** 当前处理的视频文件名 */
  current: string
}

export interface LibraryApi {
  listFolders(): Promise<WatchFolderDto[]>
  listDirs(dirPath: string): Promise<DirEntryDto[]>
  addFolder(args: { path: string; name: string; tagName: string | null; browseMode?: 'tree' | 'actor' }): Promise<number>
  setFolderMode(args: { id: number; mode: 'tree' | 'actor' }): Promise<void>
  updateFolder(args: { id: number; name: string; tagName: string | null }): Promise<void>
  removeFolder(id: number): Promise<void>
  deleteDir(dirPath: string): Promise<{ ok: boolean; removedVideos?: number; error?: string }>
  createDir(args: { parentPath: string; name: string }): Promise<{ ok: boolean; path?: string; error?: string }>
  /** 切换目录收藏状态，返回切换后是否为收藏 */
  toggleDirFavorite(dirPath: string): Promise<boolean>
  /** 切换演员收藏状态，返回切换后是否为收藏 */
  toggleActorFavorite(actorId: number): Promise<boolean>
  pickDirectory(): Promise<string | null>
  scan(args?: { folderId?: number; dirPath?: string }): Promise<ScanSummaryDto[]>
  queryVideos(q: VideoQuery): Promise<VideoPageDto>
  getVideo(id: number): Promise<VideoDetailDto | null>
  updateVideo(args: VideoUpdateArgs): Promise<void>
  batchUpdateVideos(args: BatchUpdateArgs): Promise<number>
  listTags(): Promise<TagDto[]>
  createTag(name: string): Promise<number>
  renameTag(args: { id: number; name: string }): Promise<boolean>
  deleteTag(id: number): Promise<void>
  listActors(folderId?: number): Promise<ActorDto[]>
  setActorAlias(args: { id: number; alias: string }): Promise<void>
  createActor(name: string): Promise<{ ok: boolean; created?: boolean; id?: number; error?: string }>
  cleanupEmptyActors(): Promise<number>
  mergeActors(args: { targetId: number; sourceId: number }): Promise<{ ok: boolean; cancelled?: boolean; count?: number; error?: string }>
  openInPlayer(filePath: string): Promise<string>
  showInFolder(filePath: string): Promise<void>
  getSetting(key: string): Promise<string | null>
  setSetting(args: { key: string; value: string }): Promise<void>
  /** 迁移数据库到新目录（快照复制 + 写引导配置 + 自动重启）；成功后应用直接重启 */
  changeDbDir(dirPath: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  pickFile(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
  grabPreview(args: { videoPath: string; timeSec: number }): Promise<GrabFrameResult>
  grabFrame(args: { videoPath: string; videoId: number; timeSec: number }): Promise<GrabFrameResult>
  batchGrabThumbs(videos: BatchThumbItem[]): Promise<BatchThumbResult>
  /** 订阅批量缩略图生成进度，返回取消订阅函数 */
  onBatchThumbProgress(cb: (p: BatchThumbProgress) => void): () => void
  moveVideo(args: { id: number; targetDir: string }): Promise<{ ok: boolean; moved?: boolean; path?: string; error?: string }>
  renameVideo(args: { id: number; newName: string }): Promise<{ ok: boolean; renamed?: boolean; path?: string; filename?: string; error?: string }>
  deleteVideo(id: number): Promise<{ ok: boolean; cancelled?: boolean; partial?: boolean; failed?: string[]; error?: string }>
}

declare global {
  interface Window {
    api: LibraryApi
  }
}

export {}
