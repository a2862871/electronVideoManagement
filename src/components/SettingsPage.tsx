import { useEffect, useState } from 'react'
import { DEFAULT_COMPRESS_CONFIG, type CompressConfig, type WatchFolderDto } from '../type/library'
import { DEFAULT_COVER_H, MAX_COVER_H, MIN_COVER_H, PORTRAIT_SCALE } from './VideoGrid'

interface Props {
  folders: WatchFolderDto[]
  /** 监控文件夹增删改后刷新（元数据） */
  onChanged(): void
}

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs text-slate-400'
const modeBtnCls = (active: boolean) =>
  `rounded-lg px-4 py-1.5 text-sm transition-colors ${
    active
      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 font-medium text-white'
      : 'border border-slate-700 text-slate-300 hover:bg-slate-800'
  }`
const presetBtnCls = (active: boolean) =>
  `rounded-md px-2.5 py-1 text-xs tabular-nums transition-colors ${
    active
      ? 'bg-cyan-600 font-medium text-white'
      : 'border border-slate-700 text-slate-400 hover:bg-slate-800 hover:text-slate-200'
  }`

type Tab = 'folders' | 'app'

const TABS: { key: Tab; label: string }[] = [
  { key: 'folders', label: '监控文件夹' },
  { key: 'app', label: '应用设置' },
]

const tabCls = (active: boolean) =>
  `rounded-lg px-4 py-1.5 text-sm transition-all duration-150 ${
    active
      ? 'bg-gradient-to-r from-cyan-600 to-indigo-600 font-medium text-white shadow-md shadow-cyan-950/50'
      : 'text-slate-300 hover:bg-slate-800/70'
  }`

export default function SettingsPage({ folders, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('folders')

  return (
    <div className='mx-auto max-w-3xl space-y-4 p-6'>
      <h2 className='text-lg font-semibold'>设置</h2>
      <div className='flex gap-2'>
        {TABS.map((t) => (
          <button key={t.key} className={tabCls(tab === t.key)} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'folders' && <FoldersSection folders={folders} onChanged={onChanged} />}
      {tab === 'app' && <AppSection />}
    </div>
  )
}

// ---------------- 监控文件夹 ----------------

function FoldersSection({ folders, onChanged }: { folders: WatchFolderDto[]; onChanged(): void }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [tagName, setTagName] = useState('')
  const [browseMode, setBrowseMode] = useState<'tree' | 'actor'>('tree')
  // 行内编辑：editingId=正在编辑的文件夹；draftName/draftTag 为编辑草稿
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftTag, setDraftTag] = useState('')

  async function pick() {
    const picked = await window.api.pickDirectory()
    if (!picked) return
    setPath(picked)
    if (!name) {
      const seg = picked.split(/[\\/]/).filter(Boolean).pop()
      setName(seg ?? '')
      setTagName(seg ?? '')
    }
  }

  async function add() {
    if (!path || !name) return
    await window.api.addFolder({ path, name, tagName: tagName || null, browseMode })
    setPath('')
    setName('')
    setTagName('')
    setBrowseMode('tree')
    onChanged()
  }

  async function toggleMode(f: WatchFolderDto) {
    await window.api.setFolderMode({ id: f.id, mode: f.browseMode === 'actor' ? 'tree' : 'actor' })
    onChanged()
  }

  function startEdit(f: WatchFolderDto) {
    setEditingId(f.id)
    setDraftName(f.name)
    setDraftTag(f.tagName ?? '')
  }

  async function saveEdit() {
    if (editingId == null) return
    const n = draftName.trim()
    if (!n) return
    await window.api.updateFolder({ id: editingId, name: n, tagName: draftTag.trim() || null })
    setEditingId(null)
    onChanged()
  }

  async function remove(id: number) {
    await window.api.removeFolder(id)
    onChanged()
  }

  return (
    <div className='space-y-4'>
      <div className='space-y-2'>
        {folders.map((f) =>
          editingId === f.id ? (
            <div key={f.id} className='space-y-2 rounded-lg border border-cyan-700 bg-slate-900 px-3 py-2'>
              <div className='grid grid-cols-2 gap-2'>
                <div>
                  <label className='mb-1 block text-xs text-slate-400'>显示名称</label>
                  <input className={inputCls} value={draftName} onChange={(e) => setDraftName(e.target.value)} autoFocus />
                </div>
                <div>
                  <label className='mb-1 block text-xs text-slate-400'>映射标签（留空清除）</label>
                  <input className={inputCls} value={draftTag} onChange={(e) => setDraftTag(e.target.value)} placeholder='例如：演示' />
                </div>
              </div>
              <div className='truncate text-xs text-slate-500'>{f.path}</div>
              <div className='flex justify-end gap-2'>
                <button className='rounded-lg border border-slate-700 px-3 py-1 text-xs text-slate-300 hover:bg-slate-900' onClick={() => setEditingId(null)}>
                  取消
                </button>
                <button
                  className='btn-primary rounded-lg px-3 py-1 text-xs font-medium text-white disabled:opacity-50'
                  disabled={!draftName.trim()}
                  onClick={saveEdit}
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div key={f.id} className='flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900 px-3 py-2'>
              <div className='min-w-0'>
                <div className='flex items-center gap-2 text-sm text-slate-200'>
                  <span className='truncate'>{f.name}</span>
                  {f.tagName && <span className='shrink-0 text-xs text-cyan-400'>#{f.tagName}</span>}
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${f.browseMode === 'actor' ? 'bg-purple-900/60 text-purple-300' : 'bg-slate-800 text-slate-400'}`}>
                    {f.browseMode === 'actor' ? '演员浏览' : '目录树'}
                  </span>
                </div>
                <div className='truncate text-xs text-slate-500'>{f.path}</div>
              </div>
              <div className='ml-3 flex shrink-0 items-center gap-3'>
                <button className='text-sm text-slate-300 hover:text-white' onClick={() => startEdit(f)}>
                  编辑
                </button>
                <button className='text-sm text-cyan-400 hover:text-cyan-300' onClick={() => toggleMode(f)}>
                  切换{f.browseMode === 'actor' ? '目录树' : '演员'}
                </button>
                <button className='text-sm text-red-400 hover:text-red-300' onClick={() => remove(f.id)}>
                  移除
                </button>
              </div>
            </div>
          ),
        )}
        {folders.length === 0 && <div className='text-sm text-slate-500'>还没有监控文件夹。</div>}
      </div>

      <div className='space-y-3 rounded-lg border border-slate-800 p-3'>
        <div className='flex gap-2'>
          <input className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder='目录路径' />
          <button className='shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900' onClick={pick}>
            选择…
          </button>
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder='显示名称' />
          <input className={inputCls} value={tagName} onChange={(e) => setTagName(e.target.value)} placeholder='映射标签（可选）' />
        </div>
        <div className='flex items-center gap-4'>
          <span className='text-xs text-slate-400'>浏览方式：</span>
          <label className='flex items-center gap-1.5 text-sm text-slate-200'>
            <input type='radio' name='browse-mode' checked={browseMode === 'tree'} onChange={() => setBrowseMode('tree')} />
            目录树（二级/三级菜单）
          </label>
          <label className='flex items-center gap-1.5 text-sm text-slate-200'>
            <input type='radio' name='browse-mode' checked={browseMode === 'actor'} onChange={() => setBrowseMode('actor')} />
            演员浏览
          </label>
        </div>
        <div className='flex justify-end'>
          <button
            className='btn-primary rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50'
            disabled={!path || !name}
            onClick={add}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------- 应用设置 ----------------

function AppSection() {
  const [ffmpegPath, setFfmpegPath] = useState('')
  const [playerPath, setPlayerPath] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [thumbMode, setThumbMode] = useState<'eager' | 'lazy'>('eager')
  const [autoScan, setAutoScan] = useState(true)
  const [showDuration, setShowDuration] = useState(true)
  const [showSize, setShowSize] = useState(true)
  const [coverH, setCoverH] = useState(DEFAULT_COVER_H)
  const [compress, setCompress] = useState<CompressConfig>(DEFAULT_COMPRESS_CONFIG)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    Promise.all([
      window.api.getSetting('ffmpegPath'),
      window.api.getSetting('playerPath'),
      window.api.getSetting('dataDir'),
      window.api.getThumbLoadMode(),
      window.api.getSetting('autoScan'),
      window.api.getSetting('showDuration'),
      window.api.getSetting('showSize'),
      window.api.getSetting('coverHeight'),
      window.api.getCompressConfig(),
    ]).then(([f, p, d, m, a, sd, ss, ch, cc]) => {
      setFfmpegPath(f ?? '')
      setPlayerPath(p ?? '')
      setDataDir(d ?? '')
      setThumbMode(m)
      setAutoScan(a !== '0') // 默认开启
      setShowDuration(sd !== '0') // 默认开启
      setShowSize(ss !== '0') // 默认开启
      const n = Number(ch)
      setCoverH(Number.isFinite(n) && n > 0 ? n : DEFAULT_COVER_H)
      if (cc) setCompress(cc)
      setLoaded(true)
    })
  }, [])

  // 压缩配置：修改后立即保存（无需点保存按钮）
  async function updateCompress(patch: Partial<CompressConfig>) {
    const next = { ...compress, ...patch }
    setCompress(next)
    await window.api.setCompressConfig(next)
  }

  // 自动扫描开关：立即生效，无需点保存
  async function toggleAutoScan(next: boolean) {
    setAutoScan(next)
    await window.api.setSetting({ key: 'autoScan', value: next ? '1' : '0' })
  }

  // 时长显示开关：立即生效，无需点保存
  async function toggleShowDuration(next: boolean) {
    setShowDuration(next)
    await window.api.setSetting({ key: 'showDuration', value: next ? '1' : '0' })
  }

  // 大小显示开关：立即生效，无需点保存
  async function toggleShowSize(next: boolean) {
    setShowSize(next)
    await window.api.setSetting({ key: 'showSize', value: next ? '1' : '0' })
  }

  // 封面高度：立即生效，无需点保存
  async function changeCoverH(next: number) {
    const v = Math.max(MIN_COVER_H, Math.min(MAX_COVER_H, Math.round(next)))
    setCoverH(v)
    await window.api.setSetting({ key: 'coverHeight', value: String(v) })
  }

  // 切换缩略图加载模式：立即生效（eager 会马上预加载），无需点保存
  async function changeThumbMode(mode: 'eager' | 'lazy') {
    const r = await window.api.setThumbLoadMode(mode)
    setThumbMode(r)
  }

  // 迁移数据库：选目录 → 主进程快照复制 + 写引导配置 → 自动重启
  async function changeDbDir() {
    const picked = await window.api.pickDirectory()
    if (!picked) return
    const r = await window.api.changeDbDir(picked)
    if (!r.ok && !r.cancelled && r.error) setError(r.error)
  }

  async function pick(target: 'ffmpeg' | 'player') {
    const picked = await window.api.pickFile({
      filters: [{ name: '可执行文件', extensions: ['exe'] }],
    })
    if (!picked) return
    if (target === 'ffmpeg') setFfmpegPath(picked)
    else setPlayerPath(picked)
  }

  async function save() {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await window.api.setSetting({ key: 'ffmpegPath', value: ffmpegPath.trim() })
      await window.api.setSetting({ key: 'playerPath', value: playerPath.trim() })
      setSaved(true)
    } catch {
      setError('保存失败，请重试')
    }
    setSaving(false)
  }

  if (!loaded) return null

  return (
    <div className='space-y-4'>
      <div className='space-y-3'>
        <div>
          <label className={labelCls}>数据库位置（当前，含缩略图 BLOB）</label>
          <div className='flex items-center gap-2'>
            <div className='min-w-0 flex-1 truncate rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-300' title={dataDir}>
              {dataDir || '未知'}
            </div>
            <button className='shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900' onClick={changeDbDir}>
              迁移到其他目录…
            </button>
          </div>
          <div className='mt-1 text-xs text-slate-500'>迁移会复制当前数据库到新位置并自动重启；开发版与打包版共用此配置，指向同一个库。</div>
        </div>
        {/* ---------- 界面设置 ---------- */}
        <div className='space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3'>
          <div className='text-sm font-medium text-slate-200'>界面设置</div>

          <div>
            <label className={labelCls}>
              封面基准高度：<span className='font-semibold text-cyan-300'>{coverH}px</span>
            </label>
            <div className='flex items-center gap-3'>
              <input
                type='range'
                className='h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-800 accent-cyan-500'
                min={MIN_COVER_H}
                max={MAX_COVER_H}
                step={1}
                value={coverH}
                onChange={(e) => changeCoverH(Number(e.target.value))}
              />
              <span className='w-14 shrink-0 text-right text-sm tabular-nums text-slate-300'>{coverH}px</span>
            </div>
            <div className='mt-1 flex flex-wrap gap-1.5'>
              {[180, 240, 309, 360].map((v) => (
                <button key={v} className={presetBtnCls(coverH === v)} onClick={() => changeCoverH(v)}>
                  {v}
                </button>
              ))}
            </div>
            <div className='mt-1 text-xs text-slate-500'>
              横版封面（16:9）的高度，据此决定列宽（约 {Math.round(coverH * (16 / 9))}px）。
              所有卡片等宽紧密排列，竖版封面按比例自然加高，最高约 {Math.round(coverH * PORTRAIT_SCALE)}px。
            </div>
          </div>
        </div>

        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className={labelCls}>预览显示视频时长</label>
            <div className='flex gap-2'>
              <button className={modeBtnCls(showDuration)} onClick={() => toggleShowDuration(true)}>
                显示
              </button>
              <button className={modeBtnCls(!showDuration)} onClick={() => toggleShowDuration(false)}>
                隐藏
              </button>
            </div>
            <div className='mt-1 text-xs text-slate-500'>
              右下角显示视频长度（多集为合计）。时长来自 NFO 的 runtime 字段，未刮削的视频不显示。
            </div>
          </div>
          <div>
            <label className={labelCls}>预览显示文件大小</label>
            <div className='flex gap-2'>
              <button className={modeBtnCls(showSize)} onClick={() => toggleShowSize(true)}>
                显示
              </button>
              <button className={modeBtnCls(!showSize)} onClick={() => toggleShowSize(false)}>
                隐藏
              </button>
            </div>
            <div className='mt-1 text-xs text-slate-500'>
              右下角以 GB 为单位显示大小（如 1.2G、0.48G），多集为合计。同时显示时长时以「·」分隔。
            </div>
          </div>
        </div>
        <div>
          <label className={labelCls}>缩略图加载模式</label>
          <div className='flex gap-2'>
            <button
              className={modeBtnCls(thumbMode === 'eager')}
              onClick={() => changeThumbMode('eager')}
            >
              一次加载
            </button>
            <button
              className={modeBtnCls(thumbMode === 'lazy')}
              onClick={() => changeThumbMode('lazy')}
            >
              懒加载
            </button>
          </div>
          <div className='mt-1 text-xs text-slate-500'>
            {thumbMode === 'eager'
              ? '启动时把全部缩略图读入内存：滚动浏览零读库，但占用内存（约 30~50KB/张）。'
              : '按需读库并缓存：内存占用低，首次看到某张图时略有延迟。'}
          </div>
        </div>
        <div>
          <label className={labelCls}>监控目录自动扫描</label>
          <div className='flex gap-2'>
            <button className={modeBtnCls(autoScan)} onClick={() => toggleAutoScan(true)}>
              开启
            </button>
            <button className={modeBtnCls(!autoScan)} onClick={() => toggleAutoScan(false)}>
              关闭
            </button>
          </div>
          <div className='mt-1 text-xs text-slate-500'>
            {autoScan
              ? '检测到目录变动后自动扫描入库（去抖 2.5 秒），新复制的视频会自动出现；切回窗口时也会补扫一次。'
              : '关闭后不再自动扫描，需手动点「扫描此目录」更新（IO 占用最低）。'}
          </div>
        </div>
        <div>
          <label className={labelCls}>FFmpeg 可执行文件路径（用于截取缩略图与压缩视频）</label>
          <div className='flex gap-2'>
            <input className={inputCls} value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder='例如 D:\tools\ffmpeg\bin\ffmpeg.exe' />
            <button className='shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900' onClick={() => pick('ffmpeg')}>
              选择…
            </button>
          </div>
          <div className='mt-1 text-xs text-slate-500'>压缩功能会优先使用同目录下的 ffprobe.exe 读取视频信息；找不到时自动回退用 ffmpeg 解析。</div>
        </div>

        {/* ---------- 视频压缩参数 ---------- */}
        <div className='space-y-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3'>
          <div className='text-sm font-medium text-slate-200'>视频压缩参数</div>

          <div>
            <label className={labelCls}>编码格式</label>
            <div className='flex flex-wrap gap-2'>
              {(
                [
                  ['h264', 'H.264'],
                  ['hevc', 'H.265'],
                  ['av1', 'AV1'],
                ] as const
              ).map(([key, text]) => (
                <button key={key} className={modeBtnCls(compress.codec === key)} onClick={() => updateCompress({ codec: key })}>
                  {text}
                </button>
              ))}
            </div>
            <div className='mt-1 text-xs text-slate-500'>
              {compress.codec === 'h264' && '兼容性最好，手机/剪辑软件/网页通吃。'}
              {compress.codec === 'hevc' && '同画质体积约为 H.264 的 60%，新设备基本都支持（推荐）。'}
              {compress.codec === 'av1' && '体积最小，但编码很慢，适合长期存档。'}
            </div>
          </div>

          <div>
            <label className={labelCls}>控制方式</label>
            <div className='flex gap-2'>
              <button className={modeBtnCls(compress.mode === 'crf')} onClick={() => updateCompress({ mode: 'crf' })}>
                质量优先（CRF）
              </button>
              <button className={modeBtnCls(compress.mode === 'size')} onClick={() => updateCompress({ mode: 'size' })}>
                指定目标大小
              </button>
            </div>
            <div className='mt-1 text-xs text-slate-500'>
              {compress.mode === 'crf'
                ? '按画质目标编码，体积自动最小（推荐）。'
                : '两遍编码，可精确控制到 MB，但耗时约翻倍。'}
            </div>
          </div>

          {compress.mode === 'crf' ? (
            <div>
              <label className={labelCls}>画质档位</label>
              <div className='flex gap-2'>
                {(
                  [
                    ['high', '高画质'],
                    ['balanced', '均衡'],
                    ['small', '更小体积'],
                  ] as const
                ).map(([key, text]) => (
                  <button key={key} className={modeBtnCls(compress.quality === key)} onClick={() => updateCompress({ quality: key })}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <label className={labelCls}>目标大小（MB）</label>
              <input
                className={inputCls}
                type='number'
                min={1}
                value={compress.targetMB}
                onChange={(e) => updateCompress({ targetMB: Math.max(1, Number(e.target.value) || 1) })}
              />
            </div>
          )}

          {compress.mode === 'crf' && compress.codec !== 'av1' && (
            <div>
              <label className={labelCls}>编码速度（CPU 模式生效）</label>
              <div className='flex gap-2'>
                {(['medium', 'slow', 'slower', 'veryslow'] as const).map((p) => (
                  <button key={p} className={modeBtnCls(compress.preset === p)} onClick={() => updateCompress({ preset: p })}>
                    {p === 'medium' ? '快' : p === 'slow' ? '慢' : p === 'slower' ? '很慢' : '极慢'}
                  </button>
                ))}
              </div>
              <div className='mt-1 text-xs text-slate-500'>越慢体积越小、画质越好，但耗时成倍增加。</div>
            </div>
          )}

          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className={labelCls}>分辨率上限</label>
              <select
                className={inputCls}
                value={compress.maxHeight}
                onChange={(e) => updateCompress({ maxHeight: Number(e.target.value) as 0 | 1080 | 720 | 480 })}
              >
                <option value={0}>保持原始</option>
                <option value={1080}>限制到 1080p</option>
                <option value={720}>限制到 720p</option>
                <option value={480}>限制到 480p</option>
              </select>
              <div className='mt-1 text-xs text-slate-500'>降分辨率是省体积最有效的手段。</div>
            </div>
            <div>
              <label className={labelCls}>帧率上限</label>
              <select
                className={inputCls}
                value={compress.maxFps}
                onChange={(e) => updateCompress({ maxFps: Number(e.target.value) as 0 | 60 | 30 | 24 })}
              >
                <option value={0}>保持原始</option>
                <option value={60}>限制到 60 fps</option>
                <option value={30}>限制到 30 fps</option>
                <option value={24}>限制到 24 fps</option>
              </select>
            </div>
          </div>

          <div>
            <label className={labelCls}>音频码率</label>
            <div className='flex gap-2'>
              {[64, 96, 128, 192].map((b) => (
                <button key={b} className={modeBtnCls(compress.audioBitrate === b)} onClick={() => updateCompress({ audioBitrate: b })}>
                  {b}k
                </button>
              ))}
            </div>
            <div className='mt-1 text-xs text-slate-500'>立体声 128k 已足够。</div>
          </div>

          <div>
            <label className={labelCls}>显卡加速（NVENC）</label>
            <div className='flex gap-2'>
              <button className={modeBtnCls(!compress.useGpu)} onClick={() => updateCompress({ useGpu: false })}>
                CPU 编码
              </button>
              <button
                className={modeBtnCls(compress.useGpu)}
                onClick={() => updateCompress({ useGpu: true })}
                disabled={compress.codec === 'av1'}
              >
                显卡编码
              </button>
            </div>
            <div className='mt-1 text-xs text-slate-500'>
              {compress.codec === 'av1'
                ? 'AV1 暂不支持显卡加速。'
                : compress.useGpu
                  ? '快 5~10 倍，同画质体积约大 10~20%（需 N 卡）。'
                  : '体积小、画质好，但较慢。'}
            </div>
          </div>

          <div className='grid grid-cols-2 gap-3'>
            <div>
              <label className={labelCls}>字幕流</label>
              <div className='flex gap-2'>
                <button className={modeBtnCls(!compress.keepSubtitles)} onClick={() => updateCompress({ keepSubtitles: false })}>
                  不保留
                </button>
                <button className={modeBtnCls(compress.keepSubtitles)} onClick={() => updateCompress({ keepSubtitles: true })}>
                  保留
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>体积保护</label>
              <div className='flex gap-2'>
                <button className={modeBtnCls(compress.onlyIfSmaller)} onClick={() => updateCompress({ onlyIfSmaller: true })}>
                  仅变小才替换
                </button>
                <button className={modeBtnCls(!compress.onlyIfSmaller)} onClick={() => updateCompress({ onlyIfSmaller: false })}>
                  总是替换
                </button>
              </div>
            </div>
          </div>
          <div className='text-xs text-slate-500'>
            开启「仅变小才替换」时，若压缩后反而更大则保留原文件（避免源文件已被高效压缩时越压越大）。
          </div>
        </div>
        <div>
          <label className={labelCls}>外部播放器地址（留空则用系统默认播放器）</label>
          <div className='flex gap-2'>
            <input className={inputCls} value={playerPath} onChange={(e) => setPlayerPath(e.target.value)} placeholder='例如 D:\tools\PotPlayer\PotPlayerMini64.exe' />
            <button className='shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900' onClick={() => pick('player')}>
              选择…
            </button>
          </div>
        </div>
        {error && <div className='text-sm text-red-400'>{error}</div>}
        {saved && <div className='text-sm text-cyan-400'>已保存。</div>}
      </div>

      <div className='flex justify-end'>
        <button
          className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
          disabled={saving}
          onClick={save}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}
