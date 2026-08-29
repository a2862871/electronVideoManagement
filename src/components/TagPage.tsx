import { useState } from 'react'
import { useDialog } from './DialogProvider'
import type { TagDto } from '../type/library'

interface Props {
  tags: TagDto[]
  onChanged(): void
  /** 按多个标签筛选（同时包含这些标签的视频） */
  onFilter(tagIds: number[]): void
}

const inputCls = 'rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'

export default function TagPage({ tags, onChanged, onFilter }: Props) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [selected, setSelected] = useState<number[]>([])
  const { confirm, alert } = useDialog()

  const filtered = query.trim()
    ? tags.filter((t) => t.name.toLowerCase().includes(query.trim().toLowerCase()))
    : tags

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.includes(t.id))

  function toggleSelect(id: number) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  }

  function toggleAll() {
    setSelected((s) => {
      if (allSelected) return s.filter((x) => !filtered.some((t) => t.id === x))
      return Array.from(new Set([...s, ...filtered.map((t) => t.id)]))
    })
  }

  async function saveRename(id: number) {
    const n = draft.trim()
    if (!n) return
    const ok = await window.api.renameTag({ id, name: n })
    if (!ok) await alert({ title: '重命名失败', message: '标签名已存在', danger: true })
    setEditingId(null)
    onChanged()
  }

  async function remove(tag: TagDto) {
    const ok = await confirm({
      title: '删除标签',
      message: `确定删除标签「${tag.name}」吗？`,
      detail: `视频不会被删除，仅移除该标签（${tag.count} 个视频受影响）。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    await window.api.deleteTag(tag.id)
    onChanged()
  }

  async function removeSelected() {
    if (selected.length === 0) return
    const names = selected
      .map((id) => tags.find((t) => t.id === id)?.name)
      .filter(Boolean)
    const ok = await confirm({
      title: '批量删除标签',
      message: `确定删除选中的 ${selected.length} 个标签吗？`,
      detail: `视频不会被删除，仅移除这些标签（${names.slice(0, 5).join('、')}${names.length > 5 ? '…' : ''}）。`,
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    for (const id of selected) {
      await window.api.deleteTag(id)
    }
    setSelected([])
    onChanged()
  }

  return (
    <div className='mx-auto max-w-3xl space-y-4 p-6'>
      <div className='flex items-center justify-between gap-4'>
        <h2 className='text-lg font-semibold'>标签管理</h2>
        <div className='flex items-center gap-2'>
          <input
            className={inputCls}
            placeholder='搜索标签…'
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button
            className='btn-primary rounded-lg px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40'
            disabled={selected.length === 0}
            onClick={() => onFilter(selected)}
            title='筛选同时包含所选标签的视频'
          >
            筛选所选{selected.length > 0 ? `（${selected.length}）` : ''}
          </button>
          <button
            className='rounded-lg border border-red-700 px-4 py-1.5 text-sm text-red-300 hover:bg-red-950/60 disabled:opacity-40'
            disabled={selected.length === 0}
            onClick={removeSelected}
            title='删除选中的标签'
          >
            删除所选{selected.length > 0 ? `（${selected.length}）` : ''}
          </button>
        </div>
      </div>

      <div className='overflow-hidden rounded-xl border border-slate-800'>
        <table className='w-full text-sm'>
          <thead className='bg-slate-900 text-left text-xs text-slate-400'>
            <tr>
              <th className='w-10 px-4 py-2 font-normal'>
                <input type='checkbox' className='accent-cyan-500' checked={allSelected} onChange={toggleAll} title='全选' />
              </th>
              <th className='px-4 py-2 font-normal'>标签</th>
              <th className='w-24 px-4 py-2 font-normal'>视频数</th>
              <th className='w-44 px-4 py-2 text-right font-normal'>操作</th>
            </tr>
          </thead>
          <tbody className='divide-y divide-slate-800 bg-slate-950'>
            {filtered.map((t) => (
              <tr key={t.id}>
                <td className='px-4 py-2'>
                  <input
                    type='checkbox'
                    className='accent-cyan-500'
                    checked={selected.includes(t.id)}
                    onChange={() => toggleSelect(t.id)}
                  />
                </td>
                <td className='px-4 py-2'>
                  {editingId === t.id ? (
                    <input
                      className={inputCls}
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveRename(t.id)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                    />
                  ) : (
                    <span className='text-slate-200'>{t.name}</span>
                  )}
                </td>
                <td className='px-4 py-2 text-slate-400'>{t.count}</td>
                <td className='px-4 py-2 text-right'>
                  <button className='mr-3 text-cyan-400 hover:text-cyan-300' onClick={() => onFilter([t.id])}>
                    筛选
                  </button>
                  <button
                    className='mr-3 text-slate-400 hover:text-slate-200'
                    onClick={() => { setEditingId(t.id); setDraft(t.name) }}
                  >
                    重命名
                  </button>
                  <button className='text-red-400 hover:text-red-300' onClick={() => remove(t)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
            {tags.length === 0 && (
              <tr>
                <td colSpan={4} className='px-4 py-6 text-center text-slate-500'>
                  还没有标签。
                </td>
              </tr>
            )}
            {tags.length > 0 && filtered.length === 0 && (
              <tr>
                <td colSpan={4} className='px-4 py-6 text-center text-slate-500'>
                  没有匹配「{query.trim()}」的标签。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
