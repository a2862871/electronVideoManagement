import { useState } from 'react'

interface Props {
  filename: string
  onClose(): void
  onDone(newName: string): void
}

/** 重命名视频文件：输入新文件名主干（不含扩展名），扩展名保持不变。 */
export default function RenameDialog({ filename, onClose, onDone }: Props) {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  const ext = dot > 0 ? filename.slice(dot) : ''
  const [name, setName] = useState(stem)
  const [busy, setBusy] = useState(false)

  return (
    <div className='fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6'>
      <div className='anim-dialog w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-950 p-5 shadow-2xl shadow-black/60'>
        <div className='text-lg font-semibold text-slate-100'>重命名文件</div>
        <div className='text-xs text-slate-500'>修改文件名主干，扩展名（{ext || '无'}）保持不变；同目录的同名 NFO 与封面也会一并重命名。</div>
        <div className='flex items-center gap-2'>
          <input
            className='w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-cyan-500 focus:outline-none'
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && name.trim() && name.trim() !== stem && onDone(name.trim())}
          />
          <span className='shrink-0 text-sm text-slate-500'>{ext}</span>
        </div>
        <div className='flex justify-end gap-2'>
          <button
            className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 hover:bg-slate-900'
            onClick={onClose}
          >
            取消
          </button>
          <button
            className='btn-primary rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-40'
            disabled={busy || !name.trim() || name.trim() === stem}
            onClick={() => {
              setBusy(true)
              onDone(name.trim())
            }}
          >
            {busy ? '重命名中…' : '确认'}
          </button>
        </div>
      </div>
    </div>
  )
}
