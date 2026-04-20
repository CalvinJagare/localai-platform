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

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = Math.random().toString(36).slice(2)
    setToasts(prev => [...prev, { id, type, message }])
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000)
  }, [])

  const STYLE: Record<ToastType, string> = {
    success: 'bg-green-950 border-green-700 text-green-300',
    error:   'bg-red-950   border-red-700   text-red-300',
    info:    'bg-gray-900  border-gray-700  text-gray-200',
  }
  const ICON: Record<ToastType, string> = { success: '✓', error: '✕', info: 'ℹ' }

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`flex items-start gap-2.5 px-4 py-3 border rounded-xl text-sm shadow-xl pointer-events-auto transition-all ${STYLE[t.type]}`}
          >
            <span className="font-bold mt-0.5 shrink-0">{ICON[t.type]}</span>
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)
