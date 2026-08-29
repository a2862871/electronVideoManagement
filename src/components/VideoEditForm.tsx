import { useState } from 'react'
import type { VideoDetailDto } from '../type/library'

interface Props {
  detail: VideoDetailDto
  onClose(): void
  onSaved(): void
}

const inputCls = 'w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
const labelCls = 'mb-1 block text-xs text-slate-400'

/** 编辑视频元数据：字段与 VideoDetailDto / VideoUpdateArgs 一一对应。 */
export default function VideoEditForm({ detail, onClose, onSaved }: Props) {
  const [form, setForm] = useState({
    title: detail.title ?? '',
    originaltitle: detail.originaltitle ?? '',
    num: detail.num ?? '',
    part: detail.part ?? '',
    sub_dir: detail.sub_dir ?? '',
    studio: detail.studio ?? '',
    series: detail.series ?? '',
    releasedate: detail.releasedate ?? '',
    rating: detail.rating != null ? String(detail.rating) : '',
    runtime: detail.runtime != null ? String(detail.runtime) : '',
    plot: detail.plot ?? '',
    actorNames: detail.actors.join(', '),
    tagNames: detail.tags.join(', '),
  })
  const [saving, setSaving] = useState(false)

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }))

  const split = (s: string) => s.split(/[,，]/).map((x) => x.trim()).filter(Boolean)

  async function save() {
    setSaving(true)
    await window.api.updateVideo({
      id: detail.id,
      title: form.title || undefined,
      originaltitle: form.originaltitle || undefined,
      num: form.num || undefined,
      part: form.part || undefined,
      sub_dir: form.sub_dir || undefined,
      studio: form.studio || undefined,
      series: form.series || undefined,
      releasedate: form.releasedate || undefined,
      rating: form.rating ? Number(form.rating) : undefined,
      runtime: form.runtime ? Number(form.runtime) : undefined,
      plot: form.plot || undefined,
      actorNames: split(form.actorNames),
      tagNames: split(form.tagNames),
    })
    setSaving(false)
    onSaved()
  }

  return (
    <div className='fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6'>
      <div
        className='anim-dialog max-h-full w-full max-w-2xl space-y-3 overflow-y-auto rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl shadow-black/60'
        onClick={(e) => e.stopPropagation()}
      >
        <div className='text-lg font-semibold text-slate-100'>编辑视频信息</div>

        <div>
          <label className={labelCls}>标题</label>
          <input className={inputCls} value={form.title} onChange={set('title')} />
        </div>
        <div className='grid grid-cols-2 gap-3'>
          <div>
            <label className={labelCls}>原名（originaltitle）</label>
            <input className={inputCls} value={form.originaltitle} onChange={set('originaltitle')} />
          </div>
          <div>
            <label className={labelCls}>番号</label>
            <input className={inputCls} value={form.num} onChange={set('num')} />
          </div>
          <div>
            <label className={labelCls}>分集</label>
            <input className={inputCls} value={form.part} onChange={set('part')} />
          </div>
          <div>
            <label className={labelCls}>二级目录</label>
            <input className={inputCls} value={form.sub_dir} onChange={set('sub_dir')} placeholder='整理时移动到该目录' />
          </div>
          <div>
            <label className={labelCls}>片商</label>
            <input className={inputCls} value={form.studio} onChange={set('studio')} />
          </div>
          <div>
            <label className={labelCls}>系列</label>
            <input className={inputCls} value={form.series} onChange={set('series')} />
          </div>
          <div>
            <label className={labelCls}>发行日期</label>
            <input className={inputCls} value={form.releasedate} onChange={set('releasedate')} />
          </div>
          <div>
            <label className={labelCls}>评分</label>
            <input className={inputCls} value={form.rating} onChange={set('rating')} />
          </div>
          <div>
            <label className={labelCls}>时长（分钟）</label>
            <input className={inputCls} value={form.runtime} onChange={set('runtime')} />
          </div>
        </div>
        <div>
          <label className={labelCls}>演员（逗号分隔）</label>
          <input className={inputCls} value={form.actorNames} onChange={set('actorNames')} />
        </div>
        <div>
          <label className={labelCls}>标签（逗号分隔）</label>
          <input className={inputCls} value={form.tagNames} onChange={set('tagNames')} />
        </div>
        <div>
          <label className={labelCls}>简介</label>
          <textarea className={`${inputCls} h-24 resize-none`} value={form.plot} onChange={set('plot')} />
        </div>

        <div className='flex justify-end gap-2 pt-1'>
          <button className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900' onClick={onClose}>
            取消
          </button>
          <button
            className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50'
            disabled={saving}
            onClick={save}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
