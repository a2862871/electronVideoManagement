import { useEffect, useState } from 'react'
import type { WatchFolderDto } from '../type/library'

interface Props {
  folders: WatchFolderDto[]
  /** 监控文件夹增删改后刷新（元数据） */
  onChanged(): void
}

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs text-slate-400'

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
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    Promise.all([window.api.getSetting('ffmpegPath'), window.api.getSetting('playerPath'), window.api.getSetting('dataDir')]).then(([f, p, d]) => {
      setFfmpegPath(f ?? '')
      setPlayerPath(p ?? '')
      setDataDir(d ?? '')
      setLoaded(true)
    })
  }, [])

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
        <div>
          <label className={labelCls}>FFmpeg 可执行文件路径（用于截取缩略图）</label>
          <div className='flex gap-2'>
            <input className={inputCls} value={ffmpegPath} onChange={(e) => setFfmpegPath(e.target.value)} placeholder='例如 D:\tools\ffmpeg\bin\ffmpeg.exe' />
            <button className='shrink-0 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900' onClick={() => pick('ffmpeg')}>
              选择…
            </button>
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
