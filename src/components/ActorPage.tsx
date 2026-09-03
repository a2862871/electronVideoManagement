import { useEffect, useRef, useState } from 'react'
import { useDialog } from './DialogProvider'
import type { ActorDto } from '../type/library'

interface Props {
  actors: ActorDto[]
  onChanged(): void
  onFilter(actorId: number): void
}

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'

/** 演员管理：列出所有演员，可配置曾用名（逗号分隔），支持 Ctrl+F 搜索。 */
export default function ActorPage({ actors, onChanged, onFilter }: Props) {
  // 行内草稿：key=演员id，value=当前输入框内容；保存成功后清除，回落到服务端值
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const [savingId, setSavingId] = useState<number | null>(null)
  // 合并对话框：sourceId = 要被合并掉的演员；targetId = 保留的演员
  const [mergeSource, setMergeSource] = useState<ActorDto | null>(null)
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null)
  const [merging, setMerging] = useState(false)
  // 搜索
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  // 新增演员
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)
  // 正在编辑曾用名的行：{ id, text }，用于防抖检测
  const [editingAlias, setEditingAlias] = useState<{ id: number; text: string } | null>(null)
  // 记录已提示过的合并对（"当前演员id|已存在演员id"），避免同一组合反复弹窗
  const promptedRef = useRef<Set<string>>(new Set())
  // 批量删除弹窗：输入名字 → 检查匹配 → 确认删除
  const [batchDelOpen, setBatchDelOpen] = useState(false)
  const [batchDelInput, setBatchDelInput] = useState('')
  const [batchDelResult, setBatchDelResult] = useState<{ matched: ActorDto[]; unmatched: string[] } | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const { confirm, alert } = useDialog()

  const valueOf = (a: ActorDto) => drafts[a.id] ?? a.alias ?? ''

  // 统一刷新入口：清空残留的曾用名编辑状态（否则列表刷新会再次触发防抖检测、
  // 弹出阻塞式 confirm，导致输入框短暂"卡死"），再通知父级重载数据。
  function refresh() {
    setEditingAlias(null)
    onChanged()
  }

  // Ctrl+F / Cmd+F 聚焦搜索框（阻止浏览器默认查找，因为页面内已自行过滤）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        searchRef.current?.focus()
        searchRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 名字比较键：去掉全部空白（含名字中间的空格）再转小写，使「田中 太郎」与「田中太郎」视为同名
  const nameKey = (s: string) => s.replace(/\s+/g, '').toLowerCase()

  // 在「曾用名」输入框填写时：停顿 600ms 后，若输入的名字恰好是库中另一位
  // 已存在演员（主名或曾用名，忽略空格与大小写），弹窗询问是否将其合并进当前行演员。
  async function promptMergeIfAliasHit(me: ActorDto, text: string) {
    const pieces = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    if (pieces.length === 0) return
    for (const piece of pieces) {
      const key = nameKey(piece)
      const match = actors.find((a) => {
        if (a.id === me.id) return false
        const names = [a.name, ...(a.alias ?? '').split(/[,，]/).map((s) => s.trim()).filter(Boolean)]
        return names.some((n) => nameKey(n) === key)
      })
      if (!match) continue
      const lock = `${me.id}|${match.id}`
      if (promptedRef.current.has(lock)) return
      promptedRef.current.add(lock)
      const ok = await confirm({
        title: '发现同名演员',
        message: `「${match.name}」已是库中已存在演员（${match.count} 部作品）。`,
        detail: `是否将「${match.name}」合并到「${me.name}」？`,
        confirmText: '合并',
      })
      if (ok) {
        const r = await window.api.mergeActors({ targetId: me.id, sourceId: match.id })
        if (r.ok) {
          refresh()
          await alert({ title: '合并成功', message: `「${match.name}」已并入「${me.name}」，共 ${r.count} 部作品` })
        } else if (!r.cancelled) {
          await alert({ title: '合并失败', message: r.error ?? '未知错误', danger: true })
        }
      }
      return // 每次只处理第一个命中
    }
  }

  function onAliasChange(a: ActorDto, value: string) {
    setDrafts((d) => ({ ...d, [a.id]: value }))
    setEditingAlias({ id: a.id, text: value })
  }

  // 防抖：用户停止输入 600ms 后执行检测
  useEffect(() => {
    if (!editingAlias) return
    if (mergeSource) return
    const t = setTimeout(() => {
      const me = actors.find((a) => a.id === editingAlias.id)
      if (me) promptMergeIfAliasHit(me, editingAlias.text)
    }, 600)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingAlias, actors, mergeSource])

  const filtered = (() => {
    const q = query.trim().toLowerCase()
    if (!q) return actors
    return actors.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.alias ?? '').toLowerCase().includes(q),
    )
  })()

  async function doMerge() {
    if (!mergeSource || mergeTargetId == null) return
    setMerging(true)
    const r = await window.api.mergeActors({ targetId: mergeTargetId, sourceId: mergeSource.id })
    setMerging(false)
    if (!r.ok) {
      if (!r.cancelled) await alert({ title: '合并失败', message: r.error ?? '未知错误', danger: true })
      return
    }
    const target = actors.find((a) => a.id === mergeTargetId)
    setMergeSource(null)
    setMergeTargetId(null)
    refresh()
    await alert({ title: '合并成功', message: `作品已归入「${target?.name ?? mergeTargetId}」，共 ${r.count} 部` })
  }

  async function saveAlias(a: ActorDto) {
    setSavingId(a.id)
    await window.api.setActorAlias({ id: a.id, alias: (drafts[a.id] ?? '').trim() })
    setSavingId(null)
    setDrafts((d) => {
      const next = { ...d }
      delete next[a.id]
      return next
    })
    refresh()
  }

  async function createActor() {
    const n = newName.trim()
    if (!n || creating) return
    setCreating(true)
    const r = await window.api.createActor(n)
    setCreating(false)
    if (!r.ok) {
      await alert({ title: '新增失败', message: r.error ?? '未知错误', danger: true })
      return
    }
    setNewName('')
    refresh()
    if (r.created) {
      await alert({ title: '新增成功', message: `已新增演员「${n}」` })
    } else {
      await alert({ title: '提示', message: `「${n}」已存在，未重复创建` })
    }
  }

  async function deleteActor(a: ActorDto) {
    const ok = await confirm({
      title: '删除演员',
      message: `将删除演员「${a.name}」，并从 ${a.count} 部作品中移除该演员的标记。`,
      detail: '作品文件本身不会被删除或修改。此操作不可撤销，确定继续吗？',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    const removed = await window.api.deleteActor(a.id)
    refresh()
    await alert({ title: '删除完成', message: `已删除「${a.name}」，解除 ${removed} 处作品关联` })
  }

  // 批量删除：按名字（主名或曾用名，忽略空格与大小写）匹配输入的每一位
  function checkBatchDelete() {
    const pieces = batchDelInput.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    const matched: ActorDto[] = []
    const unmatched: string[] = []
    const seen = new Set<number>()
    for (const piece of pieces) {
      const key = nameKey(piece)
      const hit = actors.find((a) => {
        if (seen.has(a.id)) return false
        const names = [a.name, ...(a.alias ?? '').split(/[,，]/)]
        return names.some((n) => nameKey(n) === key)
      })
      if (hit) {
        seen.add(hit.id)
        matched.push(hit)
      } else {
        unmatched.push(piece)
      }
    }
    setBatchDelResult({ matched, unmatched })
  }

  async function doBatchDelete() {
    const res = batchDelResult
    if (!res || res.matched.length === 0 || batchDeleting) return
    setBatchDeleting(true)
    let removed = 0
    const failed: string[] = []
    for (const a of res.matched) {
      try {
        removed += await window.api.deleteActor(a.id)
      } catch {
        failed.push(a.name)
      }
    }
    setBatchDeleting(false)
    setBatchDelOpen(false)
    setBatchDelInput('')
    setBatchDelResult(null)
    refresh()
    const okCount = res.matched.length - failed.length
    await alert({
      title: failed.length ? '批量删除（部分失败）' : '批量删除完成',
      message: failed.length
        ? `已删除 ${okCount} 位演员（解除 ${removed} 处作品关联）；删除失败：${failed.join('、')}`
        : `已删除 ${okCount} 位演员，共解除 ${removed} 处作品关联`,
      danger: failed.length > 0,
    })
  }

  async function cleanupEmpty() {
    const empty = actors.filter((a) => a.count === 0)
    if (empty.length === 0) {
      await alert({ title: '提示', message: '没有作品数为 0 的演员' })
      return
    }
    const sample = empty.slice(0, 3).map((a) => a.name).join('、')
    const ok = await confirm({
      title: '清理空演员',
      message: `将删除 ${empty.length} 位作品数为 0 的演员（如：${sample}${empty.length > 3 ? '…' : ''}）`,
      detail: '此操作不可撤销，确定继续吗？',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    const n = await window.api.cleanupEmptyActors()
    refresh()
    await alert({ title: '清理完成', message: `已删除 ${n} 位空演员` })
  }

  return (
    <div className='mx-auto max-w-4xl space-y-4 p-6'>
      <div className='flex items-center justify-between gap-3'>
        <h2 className='text-lg font-semibold'>演员管理</h2>
        <div className='flex items-center gap-2'>
          <input
            ref={searchRef}
            className='w-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
            placeholder='搜索演员 / 曾用名（Ctrl+F）'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              className='rounded-lg border border-slate-700 px-2 py-1.5 text-sm text-slate-400 hover:bg-slate-900'
              onClick={() => setQuery('')}
              title='清除搜索'
            >
              ✕
            </button>
          )}
          <span className='ml-1 text-xs text-slate-500'>共 {actors.length} 位演员</span>
          <button
            className='ml-1 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-900'
            onClick={cleanupEmpty}
            title='删除作品数为 0 的演员'
          >
            清理空演员
          </button>
          <button
            className='ml-1 rounded-lg border border-red-900/70 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/40'
            onClick={() => { setBatchDelInput(''); setBatchDelResult(null); setBatchDelOpen(true) }}
            title='按名字批量删除演员'
          >
            批量删除
          </button>
        </div>
      </div>

      <div className='flex items-center gap-2'>
        <input
          className='w-56 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
          placeholder='新增演员名字，如：夏希栗'
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && createActor()}
        />
        <button
          className='btn-primary rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50'
          disabled={creating || !newName.trim()}
          onClick={createActor}
        >
          {creating ? '新增中…' : '新增演员'}
        </button>
        <span className='text-xs text-slate-500'>可先手动添加演员，再在「曾用名」中填入已有演员以触发合并。</span>
      </div>

      <div className='overflow-hidden rounded-xl border border-slate-800'>
        <table className='w-full text-sm'>
          <thead className='bg-slate-900 text-left text-xs text-slate-400'>
            <tr>
              <th className='w-44 px-4 py-2 font-normal'>演员</th>
              <th className='min-w-56 px-4 py-2 font-normal'>曾用名（逗号分隔）</th>
              <th className='w-20 px-4 py-2 font-normal'>视频数</th>
              <th className='w-56 px-4 py-2 text-right font-normal'>操作</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-800 bg-slate-950'>
            {filtered.map((a) => (
              <tr key={a.id}>
                <td className='px-4 py-2 text-slate-200'>{a.name}</td>
                <td className='px-4 py-2'>
                  <input
                    className={inputCls}
                    value={valueOf(a)}
                    placeholder='多个名字用逗号隔开，如：三上, 悠亚'
                    onChange={(e) => onAliasChange(a, e.target.value)}
                    onPaste={(e) => {
                      // 粘贴曾用名时自动去掉所有空白（含名字中间的空格）
                      const text = e.clipboardData.getData('text')
                      if (!/\s/.test(text)) return
                      e.preventDefault()
                      const el = e.currentTarget
                      const start = el.selectionStart ?? el.value.length
                      const end = el.selectionEnd ?? el.value.length
                      const next = el.value.slice(0, start) + text.replace(/\s+/g, '') + el.value.slice(end)
                      onAliasChange(a, next)
                    }}
                    onKeyDown={(e) => e.key === 'Enter' && saveAlias(a)}
                  />
                </td>
                <td className='px-4 py-2 text-slate-400'>{a.count}</td>
                <td className='whitespace-nowrap px-4 py-2 text-right'>
                  <button className='mr-3 text-cyan-400 hover:text-cyan-300' onClick={() => onFilter(a.id)}>
                    筛选
                  </button>
                  <button
                    className='mr-3 text-amber-400/90 hover:text-amber-300'
                    onClick={() => { setMergeSource(a); setMergeTargetId(null) }}
                    title='将该演员合并到另一位演员（保留后者）'
                  >
                    合并…
                  </button>
                  <button
                    className='mr-3 text-red-400 hover:text-red-300'
                    onClick={() => deleteActor(a)}
                    title='删除该演员（不影响作品文件）'
                  >
                    删除
                  </button>
                  <button
                    className='text-slate-400 hover:text-slate-200 disabled:opacity-50'
                    disabled={savingId === a.id}
                    onClick={() => saveAlias(a)}
                  >
                    {savingId === a.id ? '保存中…' : '保存'}
                  </button>
                </td>
              </tr>
            ))}
            {actors.length === 0 && (
              <tr>
                <td colSpan={4} className='px-4 py-6 text-center text-slate-500'>
                  还没有演员，扫描带 NFO 的视频后自动生成。
                </td>
              </tr>
            )}
            {actors.length > 0 && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className='px-4 py-6 text-center text-slate-500'>
                  没有匹配「{query}」的演员。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className='text-xs text-slate-500'>
        排序规则：演员与其曾用名合并排序，列表中位置由所有名字中字母序最早者决定；搜索时输入曾用名也能匹配。
      </div>

      {batchDelOpen && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6' onClick={() => setBatchDelOpen(false)}>
          <div
            className='w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='text-lg font-semibold text-slate-100'>批量删除演员</div>
            <div>
              <label className='mb-1 block text-xs text-slate-400'>演员名（多个用逗号隔开，可用曾用名匹配，忽略空格）</label>
              <input
                className={inputCls}
                value={batchDelInput}
                placeholder='如：演员A, 演员B'
                onChange={(e) => { setBatchDelInput(e.target.value); setBatchDelResult(null) }}
                onKeyDown={(e) => e.key === 'Enter' && checkBatchDelete()}
              />
            </div>
            {batchDelResult && (
              <div className='space-y-2 text-sm'>
                {batchDelResult.matched.length > 0 && (
                  <div className='rounded-lg border border-slate-800 p-3'>
                    <div className='mb-1 text-xs text-slate-400'>将删除以下 {batchDelResult.matched.length} 位演员：</div>
                    {batchDelResult.matched.map((a) => (
                      <div key={a.id} className='text-red-300'>
                        {a.name}
                        <span className='ml-2 text-xs text-slate-500'>{a.count} 部作品</span>
                        {a.alias && <span className='ml-2 text-xs text-slate-500'>曾用名：{a.alias}</span>}
                      </div>
                    ))}
                    <div className='mt-1 text-xs text-slate-500'>仅删除演员数据及作品关联，作品文件不受影响。不可撤销。</div>
                  </div>
                )}
                {batchDelResult.matched.length === 0 && (
                  <div className='text-slate-400'>没有匹配到任何演员。</div>
                )}
                {batchDelResult.unmatched.length > 0 && (
                  <div className='text-xs text-amber-400/90'>未找到：{batchDelResult.unmatched.join('、')}</div>
                )}
              </div>
            )}
            <div className='flex justify-end gap-2'>
              <button className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900' onClick={() => setBatchDelOpen(false)}>
                取消
              </button>
              <button
                className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-900 disabled:opacity-50'
                disabled={!batchDelInput.trim() || batchDeleting}
                onClick={checkBatchDelete}
              >
                检查
              </button>
              <button
                className='rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:opacity-50'
                disabled={!batchDelResult || batchDelResult.matched.length === 0 || batchDeleting}
                onClick={doBatchDelete}
              >
                {batchDeleting ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}

      {mergeSource && (
        <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6' onClick={() => setMergeSource(null)}>
          <div
            className='w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5'
            onClick={(e) => e.stopPropagation()}
          >
            <div className='text-lg font-semibold text-slate-100'>合并演员</div>
            <div className='text-sm text-slate-300'>
              将 <span className='text-amber-300'>{mergeSource.name}</span> 合并到：
            </div>
            <div className='max-h-60 space-y-1 overflow-y-auto'>
              {actors
                .filter((a) => a.id !== mergeSource.id)
                .map((a) => (
                  <button
                    key={a.id}
                    className={`block w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                      mergeTargetId === a.id ? 'border-cyan-500 bg-cyan-950/50 text-cyan-200' : 'border-slate-800 text-slate-300 hover:bg-slate-900'
                    }`}
                    onClick={() => setMergeTargetId(a.id)}
                  >
                    <span className='font-medium'>{a.name}</span>
                    <span className='ml-2 text-xs text-slate-500'>{a.count} 部</span>
                    {a.alias && <span className='ml-2 text-xs text-slate-500'>曾用名：{a.alias}</span>}
                  </button>
                ))}
            </div>
            <div className='text-xs text-slate-500'>
              合并后：「{mergeSource.name}」的作品与曾用名归入所选演员，其自身将从列表删除。
            </div>
            <div className='flex justify-end gap-2'>
              <button className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900' onClick={() => setMergeSource(null)}>
                取消
              </button>
              <button
                className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
                disabled={mergeTargetId == null || merging}
                onClick={doMerge}
              >
                {merging ? '合并中…' : '确认合并'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
