import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export interface DialogOptions {
  title?: string
  message: string
  /** 附加说明，支持换行，浅色小字 */
  detail?: string
  confirmText?: string
  cancelText?: string
  /** danger=true 时确认按钮为红色（危险操作） */
  danger?: boolean
  /** 是否显示取消按钮（alert 恒为 false，confirm 默认 true） */
  showCancel?: boolean
}

interface Pending {
  options: DialogOptions
  resolve: (v: boolean) => void
}

interface DialogApi {
  /** 确认框：返回 Promise<boolean>，用户确认返回 true */
  confirm(options: DialogOptions): Promise<boolean>
  /** 提示框：等待用户点击「确定」后 resolve */
  alert(options: DialogOptions): Promise<void>
}

const Ctx = createContext<DialogApi | null>(null)

export function useDialog(): DialogApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useDialog 必须在 DialogProvider 内使用')
  return ctx
}

/** 统一的美化对话框：替代浏览器原生 alert/confirm，视觉与深色主题一致。 */
export default function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null)

  const close = useCallback((v: boolean) => {
    setPending((p) => {
      p?.resolve(v)
      return null
    })
  }, [])

  const confirm = useCallback((options: DialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ options: { ...options, showCancel: options.showCancel !== false }, resolve })
    })
  }, [])

  const alert = useCallback((options: DialogOptions) => {
    return new Promise<void>((resolve) => {
      setPending({
        options: { ...options, showCancel: false },
        resolve: () => resolve(),
      })
    })
  }, [])

  // ESC 视为取消
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, close])

  return (
    <Ctx.Provider value={{ confirm, alert }}>
      {children}

      {pending && (
        <div className='fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm'>
          <div className='anim-dialog w-full max-w-md space-y-4 rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl shadow-black/60'>
            <div className='flex items-start gap-3'>
              <div
                className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-lg ${
                  pending.options.danger
                    ? 'bg-red-950/80 text-red-400'
                    : 'bg-cyan-950/80 text-cyan-400'
                }`}
              >
                {pending.options.danger ? '!' : 'i'}
              </div>
              <div className='min-w-0 flex-1 space-y-1.5'>
                {pending.options.title && (
                  <div className={`text-base font-semibold ${pending.options.danger ? 'text-red-400' : 'text-slate-100'}`}>
                    {pending.options.title}
                  </div>
                )}
                <div className='text-sm leading-relaxed text-slate-300'>{pending.options.message}</div>
                {pending.options.detail && (
                  <div className='whitespace-pre-wrap rounded-lg bg-slate-950/70 px-3 py-2 text-xs leading-relaxed text-slate-500'>
                    {pending.options.detail}
                  </div>
                )}
              </div>
            </div>

            <div className='flex justify-end gap-2'>
              {pending.options.showCancel && (
                <button
                  className='rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-slate-800'
                  onClick={() => close(false)}
                >
                  {pending.options.cancelText ?? '取消'}
                </button>
              )}
              <button
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition ${
                  pending.options.danger ? 'bg-red-600 hover:bg-red-500' : 'btn-primary'
                }`}
                onClick={() => close(true)}
              >
                {pending.options.confirmText ?? '确定'}
              </button>
            </div>
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}
