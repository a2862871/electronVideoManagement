import { useEffect, useRef, useState } from 'react'
import { useDialog } from './DialogProvider'
import ContextMenu from './ContextMenu'
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
  // 名称排序：default = 后端默认（视频数优先），点击「标签」表头循环切换
  const [sort, setSort] = useState<'default' | 'name-asc' | 'name-desc'>('default')
  // 框选：dragging 期间跟踪橡皮筋矩形并实时更新选中行
  const [dragging, setDragging] = useState(false)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const tbodyRef = useRef<HTMLTableSectionElement>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const { confirm, alert } = useDialog()

  const filtered = (() => {
    const q = query.trim().toLowerCase()
    const base = q ? tags.filter((t) => t.name.toLowerCase().includes(q)) : tags
    if (sort === 'default') return base
    const arr = [...base].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return sort === 'name-asc' ? arr : [...arr].reverse()
  })()

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

  // 框选开始：左键按下且不在控件上时记录起点；拖动中矩形与行相交即选中
  function onTbodyMouseDown(e: React.MouseEvent) {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('input,button')) return
    startRef.current = { x: e.clientX, y: e.clientY }
    setMarquee({ x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY })
    setDragging(true)
    setSelected([])
  }

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const start = startRef.current
      if (!start) return
      setMarquee({ x0: start.x, y0: start.y, x1: e.clientX, y1: e.clientY })
      const rect = {
        left: Math.min(start.x, e.clientX), right: Math.max(start.x, e.clientX),
        top: Math.min(start.y, e.clientY), bottom: Math.max(start.y, e.clientY),
      }
      const ids: number[] = []
      tbodyRef.current?.querySelectorAll('tr[data-tag-id]').forEach((tr) => {
        const r = tr.getBoundingClientRect()
        if (r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top) {
          ids.push(Number(tr.getAttribute('data-tag-id')))
        }
      })
      setSelected(ids)
    }
    const onUp = () => {
      startRef.current = null
      setMarquee(null)
      setDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [dragging])

  // 右键某行：若该行未在选中集合里则单独选中它，再弹出菜单
  function onRowContextMenu(e: React.MouseEvent, id: number) {
    e.preventDefault()
    setSelected((s) => (s.includes(id) ? s : [id]))
    setCtxMenu({ x: e.clientX, y: e.clientY })
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
        <div className='bg-slate-900 px-4 py-1 text-xs text-slate-500'>按住左键拖动可框选多行，右键所选可批量删除。</div>
        <table className={`w-full text-sm ${dragging ? 'select-none' : ''}`}>
          <thead className='bg-slate-900 text-left text-xs text-slate-400'>
            <tr>
              <th className='w-10 px-4 py-2 font-normal'>
                <input type='checkbox' className='accent-cyan-500' checked={allSelected} onChange={toggleAll} title='全选' />
              </th>
              <th className='px-4 py-2 font-normal'>
                <button
                  className='hover:text-slate-200'
                  onClick={() => setSort((s) => (s === 'default' ? 'name-asc' : s === 'name-asc' ? 'name-desc' : 'default'))}
                  title='点击按名称排序（升 → 降 → 默认）'
                >
                  标签{sort === 'name-asc' ? ' ↑' : sort === 'name-desc' ? ' ↓' : ''}
                </button>
              </th>
              <th className='w-24 px-4 py-2 font-normal'>视频数</th>
              <th className='w-44 px-4 py-2 text-right font-normal'>操作</th>
            </tr>
          </thead>
          <tbody
            ref={tbodyRef}
            className='divide-y divide-slate-800 bg-slate-950'
            onMouseDown={onTbodyMouseDown}
          >
            {filtered.map((t) => (
              <tr
                key={t.id}
                data-tag-id={t.id}
                className={selected.includes(t.id) ? 'bg-cyan-950/40' : ''}
                onContextMenu={(e) => onRowContextMenu(e, t.id)}
              >
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

      {marquee && (
        <div
          className='pointer-events-none fixed z-40 rounded-sm border border-cyan-400 bg-cyan-400/10'
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)} className='w-44'>
          <button
            className='block w-full px-4 py-2 text-left text-sm text-red-300 hover:bg-slate-800'
            onClick={() => { setCtxMenu(null); removeSelected() }}
          >
            删除所选{selected.length > 1 ? `（${selected.length} 个）` : ''}
          </button>
          <button
            className='block w-full px-4 py-2 text-left text-sm text-slate-200 hover:bg-slate-800'
            onClick={() => { setCtxMenu(null); onFilter(selected) }}
          >
            筛选所选{selected.length > 1 ? `（${selected.length} 个）` : ''}
          </button>
        </ContextMenu>
      )}
    </div>
  )
}
