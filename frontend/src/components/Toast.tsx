import { createContext, useContext, useState, useCallback, type ReactNode } from 'react'

type ToastType = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  type: ToastType
  message: string
}

interface ToastCtx {
  addToast: (type: ToastType, message: string) => void
}

const ToastContext = createContext<ToastCtx>({ addToast: () => {} })

const HEADER: Record<ToastType, string> = {
  success: 'Mission Success',
  error:   'Alert',
  info:    'Transmission',
}

const ICON: Record<ToastType, string> = { success: '✓', error: '✕', info: 'ℹ' }

const BORDER: Record<ToastType, string> = {
  success: 'border-emerald-500/40',
  error:   'border-red-500/40',
  info:    'border-indigo-500/40',
}

const HEADER_COLOR: Record<ToastType, string> = {
  success: 'text-emerald-400',
  error:   'text-red-400',
  info:    'text-indigo-300',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Math.random().toString(36).slice(2)
    setToasts(prev => [...prev, { id, type, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed top-5 right-5 z-50 flex flex-col gap-2 pointer-events-none max-w-sm min-w-[280px]">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`flex flex-col gap-2 px-4 py-3.5 border rounded bg-gray-800 pointer-events-auto
              shadow-xl ${BORDER[t.type]}`}
          >
            <div className={`text-[9px] font-mono tracking-[2px] uppercase ${HEADER_COLOR[t.type]}`}>
              {HEADER[t.type]}
            </div>
            <div className="flex items-start gap-2.5 text-sm text-gray-200">
              <span className={`font-bold mt-0.5 shrink-0 ${HEADER_COLOR[t.type]}`}>{ICON[t.type]}</span>
              <span>{t.message}</span>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
