import type { DirMoveProgress } from '../type/library'

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

/** 右下角移动文件夹进度浮窗：跨盘复制大目录时提供可见反馈（同盘 rename 瞬间完成，一闪而过属正常） */
export default function MoveDirToast({ progress, onClose }: { progress: DirMoveProgress; onClose: () => void }) {
  const { phase } = progress
  const done = phase === 'done'
  const failed = phase === 'error'
  const pct =
    done ? 100
    : phase === 'scan' ? 0
    : progress.totalBytes > 0 ? Math.min(100, Math.round((progress.doneBytes / progress.totalBytes) * 100))
    : 0

  return (
    <div className='anim-fade-up w-96 rounded-xl border border-slate-700 bg-slate-900/95 p-3 shadow-2xl shadow-black/60 backdrop-blur'>
      <div className='mb-1.5 flex items-center justify-between gap-2'>
        <span className='flex items-center gap-2 text-sm font-medium text-slate-200'>
          {done ? (
            <span className='flex h-4 w-4 items-center justify-center rounded-full bg-emerald-600 text-[10px] text-white'>✓</span>
          ) : failed ? (
            <span className='flex h-4 w-4 items-center justify-center rounded-full bg-red-600 text-[10px] text-white'>!</span>
          ) : (
            <span className='inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent' />
          )}
          {done ? '移动完成' : failed ? '移动失败' : '正在移动文件夹…'}
        </span>
        <button className='text-slate-500 hover:text-slate-200' title='关闭' onClick={onClose}>
          ✕
        </button>
      </div>

      <div className='h-1.5 w-full overflow-hidden rounded-full bg-slate-800'>
        <div
          className={`h-full rounded-full transition-all duration-200 ${failed ? 'bg-red-500' : 'bg-gradient-to-r from-cyan-400 to-indigo-500'}`}
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>

      <div className='mt-1.5 flex items-center justify-between gap-3 text-xs text-slate-500'>
        <span className='tabular-nums'>
          {phase === 'scan'
            ? '正在统计文件…'
            : `${fmtBytes(progress.doneBytes)} / ${fmtBytes(progress.totalBytes)}（${pct}%）`}
        </span>
        <span className='tabular-nums'>
          {progress.doneFiles}/{progress.totalFiles} 个文件
        </span>
      </div>

      {!done && !failed && progress.current && (
        <div className='mt-1 truncate text-xs text-slate-600' title={progress.current}>
          {progress.current}
        </div>
      )}
      {failed && progress.error && <div className='mt-1 text-xs text-red-400'>{progress.error}</div>}
    </div>
  )
}
