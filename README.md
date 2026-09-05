# VideoLib

个人本地视频库管理工具。桌面端 Electron 应用，用来把散落在磁盘/NAS 上的视频目录整理成可检索、可浏览、可批量处理的媒体库。

整个工具**完全离线运行、不联网刮削**：元数据来自视频同目录的 Kodi 风格 `.nfo` 文件与文件名解析，索引与缩略图存本地 SQLite，转码压缩调用本地 FFmpeg。

---

## 功能特性

### 媒体库

- **监控文件夹**：添加任意本地/网络挂载目录作为主目录，递归扫描入库。
- **多列目录树**：主目录 → 二级/三级子目录，点击即筛选；栏宽可拖拽并持久化。
- **演员浏览模式**：每个主目录可切换「目录树」或「演员浏览」两种侧栏形态。
- **封面瀑布流 / 列表视图**：双视图切换；封面为等高紧密排列的瀑布流，竖版封面按比例自然加高。
- **悬停预览**：鼠标停在封面约 400ms 后开始静音循环播放视频（从约 20% 处起播，跳过片头），快速划过不加载，同一时刻最多一个视频在播。
- **按作品聚合**：同一番号的多集自动合并为一张卡片（多集时长/大小按合计显示）。
- **无限滚动**：每页 60 条，滚动到底部自动加载下一页。
- **全局搜索 + 目录内搜索**：搜索标题 / 番号 / 文件名 / 演员；搜索范围提示条可一键切为全库搜索。
- **标签检索面板**：库视图右侧标签栏，多选标签为「同时包含」（AND）语义。
- **筛选组合**：主目录 + 子目录 + 演员 + 多标签 + 关键词，可叠加。
- **排序**：最新添加 / 最早添加 / 按名称。
- **自动入库**：`fs.watch` 递归监听监控目录，变动去抖 2.5 秒后自动扫描；切回窗口时补扫一次（SMB 挂载漏事件兜底）。可在设置中关闭以降低 IO。

### 元数据

- **NFO 解析**：读取 Kodi 风格 `.nfo`（`num` / `title` / `originaltitle` / `plot` / `premiered` / `year` / `runtime` / `studio` / `set` / `rating` / `actor` / `tag` / `genre`）。
- **文件名解析**：无 NFO 时从文件名提取番号与分集标识（如 `JUFE-188-C` → 番号 `JUFE-188`、分集 `c`）。
- **封面探测**：自动查找同目录的 `poster` / `fanart` / `thumb` 图片（支持 `.jpg/.jpeg/.png/.webp`，优先番号前缀命名）。
- **NFO 回写**：编辑视频信息后原子写回 `.nfo`（临时文件 + 重命名），保留原有属性、注释与未知节点。
- **标签管理**：标签增删改名、按作品数排序、点击筛选。
- **演员管理**：演员列表、曾用名（alias）、合并演员、清理空演员、收藏置顶、批量删除。
- **目录收藏**：常用目录星标置顶。
- **手动/批量编辑**：单个视频编辑表单；批量编辑支持按字段勾选，演员/标签可「追加」或「替换」。

### 播放

- 内置播放器：按视频真实分辨率自适应对话框尺寸、续播位置记忆、音量记忆（默认 10%）。
- 画面旋转：90° 步进旋转并持久化（`R` 键快捷旋转），旋转只在播放器黑框内生效，窗口形态不变。
- 外置播放器：可指定 PotPlayer 等外部程序打开。

### FFmpeg 能力（需自行配置 ffmpeg 路径）

- **一键补全信息**：为当前列表中缺失信息的视频批量抽取缩略图（存库 BLOB）与读取时长，已完整的自动跳过，4 路并发。
- **手动截取缩略图**：在时间轴上选点截帧并设为封面。
- **视频压缩**：H.264 / H.265 / AV1，CRF 质量档位或指定目标大小（两遍编码），分辨率/帧率上限，音频码率，字幕流保留，NVENC 显卡加速，1~4 路并行，可中途取消，支持「仅变小才替换」体积保护。
- **旋转压缩**：压缩时把旋转角度烧录进画面（transpose 滤镜），并可同时限制分辨率。
- 后台并行执行，压缩期间可继续浏览其他页面，右下角实时进度浮窗。

### 文件操作

- 重命名文件：校验非法字符与重名，同步重命名同名 NFO 与以旧文件名开头的封面图；无 NFO 时按新文件名重新解析番号/分集。
- 拖拽卡片到目录树移动（同番号多集整组移动；仅限同一主目录范围内）。
- 右键「移动视频到…」跨目录移动、批量移动到指定目录。
- 整个文件夹移动到其他父目录（跨盘复制 + 数据库同步，带进度浮窗）。
- 删除影片 / 批量删除（一次确认，从硬盘直接删除视频 + 同名 NFO + 缩略图，不进回收站）。
- 打开所在文件夹、调用系统默认或指定播放器。

### 界面与窗口

- 自定义标题栏（`titleBarStyle: hidden` + 32px overlay），深色玻璃拟态主题。
- 关闭行为可选「缩小到托盘」（后台继续运行，压缩/扫描不中断）或「完全退出」。
- 单实例锁，二次启动聚焦已有窗口。
- 设置项即时生效，无需重启。

---

## 技术栈

| 层面 | 选型 |
|---|---|
| 运行时 | Electron 42（主进程直接使用内置 `node:sqlite` 的 `DatabaseSync`） |
| 前端 | React 19 + TypeScript 6 |
| 构建 | Vite 8 + `@vitejs/plugin-react` + `vite-plugin-electron` |
| 样式 | Tailwind CSS 4（`@tailwindcss/vite` 插件） |
| XML | `fast-xml-parser`（NFO 解析） |
| 数据库 | SQLite（WAL 模式，外键约束开启，增量迁移） |
| 媒体处理 | 外部 FFmpeg / FFprobe（用户自行配置路径，可选 NVENC） |
| 测试 | Vitest |
| 打包 | electron-builder（Windows NSIS x64） |

无第三方 UI 组件库、无状态管理库：状态全部由 React Hooks 管理，样式全部为 Tailwind 原子类 + 少量自定义 CSS。

---

## 环境要求

- **Node.js**：建议 22 LTS 或更高（开发期运行 Vite / TS / Vitest）。
- **操作系统**：当前打包目标为 Windows x64（Electron 42 需 Windows 10+）。
- **FFmpeg**（可选）：缩略图截帧与视频压缩功能必须；在「设置 → 应用设置」中填写 `ffmpeg.exe` 路径。同目录下的 `ffprobe.exe` 会被优先使用，缺失时自动回退用 `ffmpeg -i` 解析视频信息。
- **显卡**（可选）：NVIDIA 显卡可启用 NVENC 硬件编码。

---

## 快速开始

```bash
# 安装依赖
npm install

# 开发模式（Vite dev server + 自动启动 Electron，改动热更新）
npm run dev

# 类型检查（渲染进程 + 主进程两套 tsconfig）
npm run typecheck

# 单元测试
npm test

# 打包（先 vite build，再 electron-builder）
npm run build
```

其他脚本：

| 命令 | 说明 |
|---|---|
| `npm run dev:wb` | 沙箱/受限环境下的开发启动器（`scripts/dev.cjs`），会剥离 `ELECTRON_RUN_AS_NODE` 后再启动 |
| `npm run preview` | 预览已构建的渲染进程产物（不含 Electron） |
| `npm run build` | 产物输出到 `release/${version}/`，安装包命名 `VideoLib_${version}_x64.exe` |

> 渲染进程必须在 Electron 中运行：直接在浏览器打开会提示「请通过 Electron 启动应用」（因为依赖 `window.api`）。

---

## 首次运行与数据位置

首次启动时应用会弹出目录选择框，让你指定**数据存储位置**（数据库 + 缩略图 BLOB 保存在此）。选择结果写入运行目录下的 `database-dir.json`，之后启动不再询问；取消则使用默认位置 `<运行目录>/database`。

- 开发模式：运行目录 = 项目根目录。
- 打包版：运行目录 = exe 所在目录。
- 开发与打包版共用同一个引导配置，可指向同一个库，避免两套索引。
- 之后可在「设置 → 应用设置 → 数据库位置」中点「迁移到其他目录…」迁移（复制数据库快照 + 自动重启）。

---

## 目录结构

```
electronVideoManagement/
├─ electron/                      # 主进程 & 预加载
│  ├─ main/
│  │  ├─ index.ts                 # 应用入口：窗口/托盘/数据目录/协议注册/单实例
│  │  └─ library/
│  │     ├─ api.ts                # IPC 总控（46 个 handler）+ 媒体协议 + 写操作
│  │     ├─ db.ts                 # SQLite 建表与增量迁移
│  │     ├─ repo.ts               # 数据访问层（纯 SQL 封装，无业务逻辑）
│  │     ├─ scanner.ts            # 目录扫描：遍历、过滤、NFO、封面探测、增量更新
│  │     ├─ filename.ts           # 文件名解析番号与分集
│  │     ├─ nfo.ts                # NFO 只读解析
│  │     ├─ nfoWrite.ts           # NFO 原子回写（保留未知节点）
│  │     ├─ thumbs.ts             # 缩略图内存缓存 + thumbcache:// 协议
│  │     ├─ watcher.ts            # fs.watch 目录监听与去抖自动扫描
│  │     ├─ compress.ts           # FFmpeg 参数构造、探测、进度解析、进程执行
│  │     └─ types.ts              # 解析结果类型
│  └─ preload/index.ts            # contextBridge 暴露 window.api / window.ipcRenderer
├─ src/                           # 渲染进程
│  ├─ App.tsx                     # 主界面：标题栏、侧栏、视图路由、全局状态
│  ├─ main.tsx                    # React 入口
│  ├─ index.css                   # Tailwind 入口 + 全局主题与少量自定义样式
│  ├─ components/                 # 16 个组件（详见下）
│  ├─ type/library.ts             # 前后端共享契约（LibraryApi 接口与所有 DTO）
│  └─ utils/media.ts              # 时长/大小格式化、媒体 URL 与封面选择
├─ test/                          # Vitest 用例（filename / nfo / scanner / browse-mode）
├─ demo-lib/                      # 演示用样例库目录（含 mp4 + nfo + 封面）
├─ scripts/dev.cjs                # 沙箱环境开发启动器
├─ vite.config.ts                 # Vite + electron 多入口构建配置（@ → src 别名）
└─ electron-builder.json          # 打包配置（NSIS x64，输出到 release/${version}）
```

### 渲染进程组件

| 组件 | 职责 |
|---|---|
| `Sidebar` | 多列目录树 / 演员栏，收藏、拖拽排序、新建/重命名/删除/移动目录 |
| `VideoGrid` | 封面瀑布流、悬停视频预览、框选、Ctrl/Shift 多选、卡片拖拽 |
| `VideoTable` | 列表视图，按文件名/大小/时长/修改时间/目录排序 |
| `VideoDetail` | 详情与内置播放器（续播、音量记忆、旋转、外置播放器） |
| `VideoEditForm` | 单个视频元数据编辑（写库 + 回写 NFO） |
| `BatchEditDialog` | 批量编辑（字段级勾选、追加/替换模式） |
| `CaptureDialog` | 手动截取缩略图 |
| `RotateCompressDialog` | 旋转压缩参数（角度 + 分辨率） |
| `RenameDialog` | 文件重命名 |
| `ContextMenu` | 通用右键菜单（portal 到 body） |
| `DialogProvider` | 应用内 alert/confirm 对话框 |
| `MoveDirToast` | 文件夹移动进度浮窗 |
| `TagPage` | 标签管理（增删改名、计数、筛选） |
| `ActorPage` | 演员管理（别名、合并、收藏、批量删除） |
| `TagSearchPanel` | 库视图右侧标签检索栏 |
| `SettingsPage` | 设置（监控文件夹 / 应用设置 / 视频压缩） |

---

## 架构说明

### 进程模型

```
渲染进程 (React)                预加载                      主进程
window.api ──invoke──▶ contextBridge ──ipcRenderer.invoke──▶ ipcMain.handle
window.api.onXxx ◀──on── contextBridge ◀──webContents.send── 进度/变更推送
```

- `src/type/library.ts` 中的 `LibraryApi` 接口是**前后端唯一契约**：preload 按此接口实现，主进程按此接口提供 handler，类型全程贯通。
- 46 个 IPC 频道按域命名：`folder:*`、`dir:*`、`videos:*`、`video:*`、`tags:*`、`actors:*`、`settings:*`、`thumbs:*`、`compress:*`、`ffmpeg:*`、`shell:*`、`db:*`、`file:*`、`scan:*`。

### 三个自定义协议

| 协议 | 用途 |
|---|---|
| `local-media://` | 手动实现 HTTP Range 分段返回与正确 MIME，用于大视频边下边播与 seek |
| `thumbcache://` | `thumbcache://img/{id}?v={版本}`，把库中的缩略图 BLOB 经内存缓存直出给 `<img>` |
| `file://` | 播放器直接使用的 Chromium 原生文件协议（已开启 `webSecurity: false`） |

### 扫描流程

1. 递归遍历目录（跳过符号链接），按扩展名过滤：`.mp4 .mkv .avi .wmv .mov .flv .ts .m4v .rmvb .webm`。
2. 读取同名 `.nfo`；解析失败或不存在则回退用文件名解析番号/分集。
3. 探测同目录封面图（`{番号}-poster` / `poster` / `{文件名}-poster` 等候选）。
4. 增量判定：`size_bytes + mtime + has_nfo` 三者均未变则跳过，否则更新记录并补录 NFO 元数据。
5. 清理：仅删除本次扫描范围内、已不在磁盘上的旧记录（避免误删范围外数据）。
6. 主目录可映射一个标签，扫描时自动打给其下所有视频。

### 缩略图

- 截帧生成的缩略图以 **BLOB 存在 `video_thumbs` 表**，随视频删除级联清理；`videos.thumb_path` 仅保留 NFO 自带的磁盘图片。
- 展示优先级：BLOB > `thumb_path` > `poster_path` > `fanart_path`。
- 加载模式可切换：**一次加载**（启动时分批 500 条读入内存，滚动零读库，约 30~50KB/张）或**懒加载**（按需读库并回填缓存，内存占用低）。

### 数据库

`videolib.db`（WAL + 外键开启），启动时按 `CREATE TABLE IF NOT EXISTS` 建表并做增量迁移：

| 表 | 说明 |
|---|---|
| `watch_folders` | 监控目录（路径、名称、映射标签、浏览模式） |
| `videos` | 视频记录（路径、番号、分集、元数据、封面路径、大小、mtime、续播位置、旋转角度） |
| `tags` / `video_tags` | 标签与多对多关联 |
| `actors` / `video_actors` | 演员（含曾用名）与多对多关联 |
| `video_thumbs` | 缩略图 BLOB（`video_id` 主键，级联删除） |
| `settings` | 键值配置（ffmpegPath、playerPath、autoScan、closeAction、coverHeight、thumbLoadMode、compressConfig、favoriteDirs、dirOrders、actorFavorites、playerVolume、viewMode…） |

### 设置项一览

**监控文件夹**：添加/编辑/移除目录、设置显示名称、映射标签、切换「目录树 / 演员浏览」模式。

**应用设置**

- 数据库位置与迁移
- 封面基准高度（150~420px，决定列宽）
- 窗口行为：缩小到托盘 / 完全退出
- 预览显示视频时长、预览显示文件大小
- 缩略图加载模式：一次加载 / 懒加载
- 监控目录自动扫描开关
- FFmpeg 可执行文件路径
- 外部播放器路径

**视频压缩**

- 编码格式：H.264 / H.265 / AV1
- 控制方式：质量优先（CRF，高画质/均衡/更小体积）或指定目标大小（两遍编码）
- 编码速度：medium / slow / slower / veryslow（CPU + CRF 模式）
- 分辨率上限、帧率上限
- 音频码率：64 / 96 / 128 / 192 k
- 同时压缩路数：1~4
- 显卡加速：CPU 编码 / NVENC（AV1 不支持）
- 字幕流保留、体积保护（仅变小才替换）

---

## 快捷键

| 按键 | 场景 | 作用 |
|---|---|---|
| `Enter` | 搜索框 | 执行搜索 |
| `Enter` | 目录内搜索 | 执行目录内搜索 |
| `Esc` | 目录内搜索 | 清空并刷新 |
| `R` | 播放器打开时 | 画面旋转 90° |
| `Ctrl / Cmd + A` | 列表视图 | 全选 |
| `Ctrl / Cmd + F` | 演员管理页 | 聚焦过滤框 |
| `Esc` | 网格/列表视图 | 清空选择 |
| `Esc` | 任意对话框 | 关闭对话框 |
| 按住 `Ctrl / Cmd / Shift` | 网格视图 | 进入多选模式（点击/框选 = 选择，不再打开详情） |

---

## 测试

```bash
npm test          # 单次运行（vitest run --passWithNoTests）
```

现有用例：

| 文件 | 覆盖内容 |
|---|---|
| `test/filename.test.ts` | 番号与分集解析（含 FC2、数字编号、字母前缀等形态） |
| `test/nfo.test.ts` | Kodi NFO 字段解析与容错 |
| `test/scanner.test.ts` | 扫描入库、增量更新、失效记录清理 |
| `test/browse-mode.test.ts` | 目录浏览模式相关逻辑 |

`demo-lib/` 提供了一套含视频、NFO 与封面的样例库，可直接添加为监控目录体验完整功能。

---

## 已知限制与注意事项

- **不联网刮削**：元数据完全依赖现成的 NFO 与文件名，不提供在线匹配；无 NFO 的视频只有时长/大小等基础信息（时长可通过「一键补全信息」用 FFmpeg 读取）。
- **单平台打包**：`electron-builder.json` 目前只配置了 Windows NSIS x64 目标。
- **`webSecurity: false`**：为让页面直接加载 `file://` 本地视频/图片而关闭，适用于「本地个人工具、不加载外部不可信网页」的场景；若要对外分发，应改回 `true` 并改用自定义协议 + CORS。
- **删除不可恢复**：删除影片直接删除硬盘文件（含 NFO 与关联图片），仅有二次确认。
- **压缩会替换原文件**：输出到同目录临时文件后替换，建议重要资料先备份；开启「仅变小才替换」可降低风险。
- **AV1 不支持显卡加速**，且 CPU 编码很慢，适合长期存档场景。
- 网络盘（SMB/NFS）下 `fs.watch` 可能漏事件，已通过窗口聚焦补扫兜底。

---

## 许可证

MIT
