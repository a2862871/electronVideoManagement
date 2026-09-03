import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * 通用右键菜单：portal 渲染到 body。
 * 不能直接放在侧边栏内部用 position:fixed——祖先的 backdrop-blur 会让 fixed 的定位基准
 * 变成该祖先而非视口，且栏的 overflow-y-auto 会裁剪菜单，导致显示不全。
 * 弹出后按菜单实测尺寸贴边，靠近窗口底部/右缘时自动收进来。
 */
export default function ContextMenu({
  x,
  y,
  onClose,
  className = '',
  children,
}: {
  x: number
  y: number
  onClose(): void
  /** 菜单面板的样式（宽度、背景等），不含定位类 */
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - r.height - 4)),
    })
  }, [x, y])

  return createPortal(
    <>
      {/* 全屏透明遮罩：点击/右键别处即关闭。stopPropagation 必须加：
          React 事件沿 React 树冒泡，遮罩在 JSX 上位于触发菜单的容器内部，
          不阻断的话关闭事件会冒泡回容器，立即把菜单重新打开（表现为关不掉）。 */}
      <div
        className='fixed inset-0 z-50'
        onClick={(e) => { e.stopPropagation(); onClose() }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onClose() }}
      />
      <div
        ref={ref}
        className={`anim-dialog fixed z-[51] overflow-hidden rounded-xl border border-slate-700 bg-slate-900 py-1 shadow-2xl shadow-black/60 ${className}`}
        style={{ left: pos.left, top: pos.top }}
      >
        {children}
      </div>
    </>,
    document.body,
  )
}
