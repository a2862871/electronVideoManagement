import { useState } from 'react'
import type { BatchUpdateArgs, VideoDetailDto } from '../type/library'

interface Props {
  /** 要批量编辑的视频 ID 列表（当前列表的全部视频） */
  videoIds: number[]
  onClose(): void
  /** 批量编辑完成后回调（刷新演员/标签等元数据） */
  onDone(): void
}

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs text-slate-400'

/**
 * 批量编辑：对当前列表的全部视频统一设置字段。
 * 每个字段按行勾选「应用此字段」，勾选后才会在保存时提交；
 * 演员/标签额外支持「替换/追加」两种模式（追加不覆盖视频已有的关联）。
 */
export default function BatchEditDialog({ videoIds, onClose, onDone }: Props) {
  const [subDir, setSubDir] = useState('')
  const [studio, setStudio] = useState('')
  const [series, setSeries] = useState('')
  const [releaseDate, setReleaseDate] = useState('')
  const [rating, setRating] = useState('')
  const [actorNames, setActorNames] = useState('')
  const [tagNames, setTagNames] = useState('')
  const [actorMode, setActorMode] = useState<'add' | 'set'>('add')
  const [tagMode, setTagMode] = useState<'add' | 'set'>('add')

  const [applySubDir, setApplySubDir] = useState(false)
  const [applyStudio, setApplyStudio] = useState(false)
  const [applySeries, setApplySeries] = useState(false)
  const [applyReleaseDate, setApplyReleaseDate] = useState(false)
  const [applyRating, setApplyRating] = useState(false)
  const [applyActors, setApplyActors] = useState(false)
  const [applyTags, setApplyTags] = useState(false)

  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<{ count: number; nfoError?: string } | null>(null)

  const split = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  const noneApplied = !applySubDir && !applyStudio && !applySeries && !applyReleaseDate && !applyRating && !applyActors && !applyTags

  async function save() {
    setSaving(true)
    const args: BatchUpdateArgs = { ids: videoIds }
    if (applySubDir) args.sub_dir = subDir.trim()
    if (applyStudio) args.studio = studio.trim()
    if (applySeries) args.series = series.trim()
    if (applyReleaseDate) args.releasedate = releaseDate.trim()
    if (applyRating) args.rating = rating ? Number(rating) : null
    if (applyActors) {
      const names = split(actorNames)
      if (actorMode === 'set') args.setActors = names
      else args.addActors = names
    }
    if (applyTags) {
      const names = split(tagNames)
      if (tagMode === 'set') args.setTags = names
      else args.addTags = names
    }
    const r = await window.api.batchUpdateVideos(args)
    setSaving(false)
    setResult(r)
    onDone()
  }

  const checkCls = 'mt-2.5 h-4 w-4 shrink-0 accent-cyan-500'
  const modeCls = 'shrink-0 rounded-lg border border-slate-700 bg-slate-900 px-2 text-xs text-slate-300 focus:border-cyan-500 focus:outline-none'

  function fieldRow(checked: boolean, onCheck: (v: boolean) => void, label: string, input: React.ReactNode) {
    return (
      <div className='flex items-start gap-3'>
        <input type='checkbox' className={checkCls} checked={checked} onChange={(e) => onCheck(e.target.checked)} title='应用此字段' />
        <div className='min-w-0 flex-1'>
          <label className={labelCls}>{label}</label>
          {input}
        </div>
      </div>
    )
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6' onClick={result ? onClose : undefined}>
      <div
        className='anim-dialog max-h-full w-full max-w-2xl space-y-3 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl shadow-black/60'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='text-lg font-semibold text-slate-100'>批量编辑</div>
        <div className='text-xs text-slate-500'>
          将对当前列表的全部 <span className='text-slate-300'>{videoIds.length}</span> 个视频生效。勾选左侧复选框的字段才会被修改，其余字段保持不变。
        </div>

        {result ? (
          <div className='py-6 text-center text-sm'>
            <div className='text-cyan-400'>已更新 {result.count} 个视频。</div>
            {result.nfoError && (
              <div className='mt-2 text-red-400'>部分 NFO 文件同步失败：{result.nfoError}</div>
            )}
          </div>
        ) : (
          <>
            <div className='space-y-3 rounded-lg border border-slate-800 p-3'>
              {fieldRow(applySubDir, setApplySubDir, '二级目录', (
                <input className={inputCls} value={subDir} onChange={(e) => setSubDir(e.target.value)} placeholder='留空则清除' />
              ))}
              {fieldRow(applyStudio, setApplyStudio, '片商', (
                <input className={inputCls} value={studio} onChange={(e) => setStudio(e.target.value)} placeholder='留空则清除' />
              ))}
              {fieldRow(applySeries, setApplySeries, '系列', (
                <input className={inputCls} value={series} onChange={(e) => setSeries(e.target.value)} placeholder='留空则清除' />
              ))}
              {fieldRow(applyReleaseDate, setApplyReleaseDate, '发行日期', (
                <input className={inputCls} value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} placeholder='例如 2024-01-01，留空则清除' />
              ))}
              {fieldRow(applyRating, setApplyRating, '评分', (
                <input className={inputCls} value={rating} onChange={(e) => setRating(e.target.value)} placeholder='0-10，留空则清除' />
              ))}
            </div>

            <div className='space-y-3 rounded-lg border border-slate-800 p-3'>
              <div className='flex items-start gap-3'>
                <input type='checkbox' className={checkCls} checked={applyActors} onChange={(e) => setApplyActors(e.target.checked)} title='应用此字段' />
                <div className='min-w-0 flex-1'>
                  <div className='mb-1 flex items-center justify-between'>
                    <label className={labelCls}>演员（逗号分隔）</label>
                    <select className={modeCls} value={actorMode} onChange={(e) => setActorMode(e.target.value as 'add' | 'set')}>
                      <option value='add'>追加（不覆盖已有）</option>
                      <option value='set'>替换（清空后设置）</option>
                    </select>
                  </div>
                  <input className={inputCls} value={actorNames} onChange={(e) => setActorNames(e.target.value)} placeholder='例如：演员A, 演员B' />
                </div>
              </div>
              <div className='flex items-start gap-3'>
                <input type='checkbox' className={checkCls} checked={applyTags} onChange={(e) => setApplyTags(e.target.checked)} title='应用此字段' />
                <div className='min-w-0 flex-1'>
                  <div className='mb-1 flex items-center justify-between'>
                    <label className={labelCls}>标签（逗号分隔）</label>
                    <select className={modeCls} value={tagMode} onChange={(e) => setTagMode(e.target.value as 'add' | 'set')}>
                      <option value='add'>追加（不覆盖已有）</option>
                      <option value='set'>替换（清空后设置）</option>
                    </select>
                  </div>
                  <input className={inputCls} value={tagNames} onChange={(e) => setTagNames(e.target.value)} placeholder='例如：标签A, 标签B' />
                </div>
              </div>
            </div>
          </>
        )}

        <div className='flex justify-end gap-2 pt-1'>
          {result ? (
            <button className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white' onClick={onClose}>
              关闭
            </button>
          ) : (
            <>
              <button className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900' onClick={onClose}>
                取消
              </button>
              <button
                className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
                disabled={saving || noneApplied}
                onClick={save}
                title={noneApplied ? '请至少勾选一个要应用的字段' : undefined}
              >
                {saving ? '保存中…' : `应用（${videoIds.length} 个视频）`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
