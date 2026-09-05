import { useMemo, useState } from 'react'
import type { TagDto } from '../type/library'

/**
 * 标签搜索面板（「全部视频」右侧栏）：
 * 顶部标签搜索框，下方全部标签按视频数降序以椭圆胶囊瀑布流排列。
 * 点标签即筛选（可多选，多标签为「同时包含」语义，由主进程查询保证）；
 * 选中的标签变亮并带 ✕，点 ✕ 取消该标签。
 */
export default function TagSearchPanel({
  tags,
  selectedIds,
  onToggle,
}: {
  tags: TagDto[]
  selectedIds: number[]
  onToggle(tagId: number): void
}) {
  const [kw, setKw] = useState('')
  // 按视频数降序（常用在前），有搜索词时按名称过滤
  const list = useMemo(() => {
    const k = kw.trim().toLowerCase()
    return [...tags]
      .filter((t) => !k || t.name.toLowerCase().includes(k))
      .sort((a, b) => b.count - a.count)
  }, [tags, kw])

  return (
    <aside className='flex w-64 shrink-0 flex-col border-l border-slate-800 bg-slate-950'>
      <div className='border-b border-slate-800 p-3'>
        <input
          className='w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 focus:border-cyan-500 focus:outline-none'
          placeholder='搜索标签…'
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setKw('')}
        />
        {selectedIds.length > 0 && (
          <div className='mt-1.5 text-xs text-slate-500'>
            已选 {selectedIds.length} 个标签，列出同时包含全部标签的视频
          </div>
        )}
      </div>
      <div className='flex-1 overflow-y-auto p-3'>
        <div className='flex flex-wrap gap-2'>
          {list.map((t) => {
            const active = selectedIds.includes(t.id)
            return active ? (
              <span
                key={t.id}
                className='inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-cyan-600 to-indigo-600 px-3 py-1 text-xs font-medium text-white'
              >
                {t.name}
                <span className='text-[10px] text-cyan-200'>{t.count}</span>
                <button
                  className='ml-0.5 text-cyan-100 hover:text-white'
                  title='取消选择该标签'
                  onClick={() => onToggle(t.id)}
                >
                  ✕
                </button>
              </span>
            ) : (
              <button
                key={t.id}
                className='inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-3 py-1 text-xs text-slate-300 transition-colors hover:border-cyan-600 hover:text-cyan-200'
                title={`包含该标签的 ${t.count} 个视频`}
                onClick={() => onToggle(t.id)}
              >
                {t.name}
                <span className='text-[10px] text-slate-600'>{t.count}</span>
              </button>
            )
          })}
          {list.length === 0 && <div className='text-xs text-slate-600'>无匹配标签</div>}
        </div>
      </div>
    </aside>
  )
}
