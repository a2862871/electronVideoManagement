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
  /** 画面旋转角度（90° 步进：0/90/180/270），播放与悬停预览时应用 */
  rotation: number
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
  /** 排序：newest=按添加时间倒序（默认）；oldest=按添加时间正序；name=按文件名升序 */
  sort?: 'newest' | 'oldest' | 'name'
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
  /** null = 清除评分（「留空则清除」） */
  rating?: number | null
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

/** 视频压缩配置（编码参数参考用户的 python 压缩脚本） */
export interface CompressConfig {
  /** 编码格式：h264 兼容性最好 / hevc 体积约 H.264 的 60% / av1 最小但很慢 */
  codec: 'h264' | 'hevc' | 'av1'
  /** crf=质量优先；size=指定目标大小（两遍编码） */
  mode: 'crf' | 'size'
  /** 画质档位（crf 模式） */
  quality: 'high' | 'balanced' | 'small'
  /** 目标大小 MB（size 模式） */
  targetMB: number
  /** 编码速度，越慢体积越小（CPU + crf 模式生效） */
  preset: 'medium' | 'slow' | 'slower' | 'veryslow'
  /** 分辨率上限，0=保持原始；1440=2K（2560×1440） */
  maxHeight: 0 | 1440 | 1080 | 720
  /** 帧率上限，0=保持原始 */
  maxFps: 0 | 60 | 30 | 24
  /** 音频码率 kbps */
  audioBitrate: number
  /** 使用 NVIDIA 显卡编码（NVENC），快很多但同画质体积略大 */
  useGpu: boolean
  /** 同时压缩的路数（1~4）：多路并行受 CPU 核心数/NVENC 编码单元限制 */
  concurrency: number
  /** 保留字幕流 */
  keepSubtitles: boolean
  /** 仅当新文件更小时才替换原文件 */
  onlyIfSmaller: boolean
}

/** 默认压缩配置（与后端保持一致） */
export const DEFAULT_COMPRESS_CONFIG: CompressConfig = {
  codec: 'hevc',
  mode: 'crf',
  quality: 'balanced',
  targetMB: 500,
  preset: 'medium',
  maxHeight: 0,
  maxFps: 0,
  audioBitrate: 128,
  useGpu: false,
  concurrency: 1,
  keepSubtitles: false,
  onlyIfSmaller: true,
}

/** 压缩进度推送 */
export interface CompressProgress {
  videoId?: number
  filename?: string
  /** 当前文件进度百分比 */
  percent?: number
  speed?: string
  outSize?: number
  /** 阶段：准备中 / 压缩中 / 分析 1/2 / 编码 2/2 / 完成 / 失败 / 已跳过（未变小） */
  stage?: string
  /** 第几个 / 共几个 */
  current?: number
  total?: number
  /** 尚未开始处理的文件名（剩余队列） */
  remaining?: string[]
  /** 全部完成时为 true */
  finished?: boolean
  cancelled?: boolean
  ok?: number
  skipped?: number
  savedBytes?: number
  failed?: { filename: string; error: string }[]
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

/** 移动文件夹进度（主进程通过 dir:move:progress 推送） */
export interface DirMoveProgress {
  /** scan=统计源目录规模；move=磁盘移动中；done=全部完成；error=失败 */
  phase: 'scan' | 'move' | 'done' | 'error'
  /** 0-100（done 恒为 100；按已复制字节估算） */
  percent: number
  doneFiles: number
  totalFiles: number
  doneBytes: number
  totalBytes: number
  /** 当前正在移动的文件名 */
  current: string
  error?: string
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
  /** 重命名子文件夹（磁盘改名 + 视频记录路径/sub_dir 同步）；renamed=false 表示名称未变化 */
  renameDir(args: { dirPath: string; newName: string }): Promise<{ ok: boolean; renamed?: boolean; path?: string; moved?: number; error?: string }>
  /** 切换目录收藏状态，返回切换后是否为收藏 */
  toggleDirFavorite(dirPath: string): Promise<boolean>
  /** 移动整个文件夹到新的父目录（磁盘移动 + 数据库同步），返回移动的视频数 */
  moveDir(args: { src: string; targetParent: string }): Promise<{ ok: boolean; cancelled?: boolean; moved?: number; dst?: string; error?: string }>
  /** 切换演员收藏状态，返回切换后是否为收藏 */
  toggleActorFavorite(actorId: number): Promise<boolean>
  /** 订阅监控目录变更（文件增删改 / 窗口聚焦兜底），返回取消订阅函数 */
  onFoldersChanged(cb: () => void): () => void
  /** 获取缩略图加载模式：eager=一次性载入内存；lazy=按需读库 */
  getThumbLoadMode(): Promise<'eager' | 'lazy'>
  /** 设置缩略图加载模式（切到 eager 会立即预加载） */
  setThumbLoadMode(mode: 'eager' | 'lazy'): Promise<'eager' | 'lazy'>
  pickDirectory(): Promise<string | null>
  scan(args?: { folderId?: number; dirPath?: string }): Promise<ScanSummaryDto[]>
  queryVideos(q: VideoQuery): Promise<VideoPageDto>
  getVideo(id: number): Promise<VideoDetailDto | null>
  /** 设置画面旋转角度（90° 步进），持久化到数据库 */
  setVideoRotation(args: { id: number; rotation: number }): Promise<void>
  /** 保存后若有同名 NFO 会同步写回；nfoError = NFO 写入失败信息（数据库已保存成功） */
  updateVideo(args: VideoUpdateArgs): Promise<{ ok: boolean; nfoError?: string }>
  batchUpdateVideos(args: BatchUpdateArgs): Promise<{ count: number; nfoError?: string }>
  listTags(): Promise<TagDto[]>
  createTag(name: string): Promise<number>
  renameTag(args: { id: number; name: string }): Promise<boolean>
  deleteTag(id: number): Promise<void>
  listActors(folderId?: number): Promise<ActorDto[]>
  setActorAlias(args: { id: number; alias: string }): Promise<void>
  createActor(name: string): Promise<{ ok: boolean; created?: boolean; id?: number; error?: string }>
  cleanupEmptyActors(): Promise<number>
  mergeActors(args: { targetId: number; sourceId: number }): Promise<{ ok: boolean; cancelled?: boolean; count?: number; error?: string }>
  /** 删除演员（仅演员记录与作品关联，不影响视频），返回解除的关联数 */
  deleteActor(id: number): Promise<number>
  openInPlayer(filePath: string): Promise<string>
  showInFolder(filePath: string): Promise<void>
  getSetting(key: string): Promise<string | null>
  setSetting(args: { key: string; value: string }): Promise<void>
  /** 迁移数据库到新目录（快照复制 + 写引导配置 + 自动重启）；成功后应用直接重启 */
  changeDbDir(dirPath: string): Promise<{ ok: boolean; cancelled?: boolean; error?: string }>
  pickFile(opts?: { filters?: { name: string; extensions: string[] }[] }): Promise<string | null>
  grabPreview(args: { videoPath: string; timeSec: number }): Promise<GrabFrameResult>
  grabFrame(args: { videoPath: string; videoId: number; timeSec: number }): Promise<GrabFrameResult>
  /** 一键补全：缺缩略图补缩略图、缺时长补时长，两者都有则跳过 */
  batchCompleteMedia(videos: BatchThumbItem[]): Promise<BatchThumbResult>
  /** 订阅一键补全进度，返回取消订阅函数 */
  onBatchMediaProgress(cb: (p: BatchThumbProgress) => void): () => void
  /** 订阅移动文件夹进度（跨盘复制大目录可能很慢），返回取消订阅函数 */
  onDirMoveProgress(cb: (p: DirMoveProgress) => void): () => void
  /** 读取视频压缩配置 */
  getCompressConfig(): Promise<CompressConfig>
  /** 保存视频压缩配置 */
  setCompressConfig(cfg: CompressConfig): Promise<void>
  /** 开始后台压缩（串行队列），完成后用新文件替换原文件；rotation 为可选的烧录旋转角度（0/90/180/270），maxHeight 为可选的分辨率上限档位（0/720/1080/1440，旋转压缩选择，覆盖本次并同步写回压缩参数） */
  startCompress(videos: { id: number; path: string; filename: string; rotation?: number; maxHeight?: number }[]): Promise<{ started: boolean; count?: number }>
  /** 取消进行中的压缩任务 */
  cancelCompress(): Promise<void>
  /** 订阅压缩进度，返回取消订阅函数 */
  onCompressProgress(cb: (p: CompressProgress) => void): () => void
  moveVideo(args: { id: number; targetDir: string }): Promise<{ ok: boolean; moved?: boolean; path?: string; error?: string }>
  renameVideo(args: { id: number; newName: string }): Promise<{ ok: boolean; renamed?: boolean; path?: string; filename?: string; error?: string }>
  deleteVideo(id: number): Promise<{ ok: boolean; cancelled?: boolean; partial?: boolean; failed?: string[]; error?: string }>
  /** 批量彻底删除：一次确认（后端弹窗），返回删除数量与失败明细 */
  deleteVideos(ids: number[]): Promise<{ ok: boolean; cancelled?: boolean; deleted?: number; failed?: string[]; error?: string }>
}

declare global {
  interface Window {
    api: LibraryApi
  }
}

export {}
