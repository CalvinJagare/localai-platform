import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import SplashScreen from './components/SplashScreen'
import ChatPage from './pages/ChatPage'
import TrainingPage from './pages/TrainingPage'
import DataPage from './pages/DataPage'
import HealthPage from './pages/HealthPage'

export type Page = 'chat' | 'training' | 'data' | 'health'

// Injected by the Tauri webview at runtime. Absent when running plain `npm run dev`.
const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export default function App() {
  const [page, setPage]   = useState<Page>('chat')
  const [phase, setPhase] = useState<'loading' | 'ready'>(IS_TAURI ? 'loading' : 'ready')
  const [status, setStatus] = useState('Initialising…')

  useEffect(() => {
    if (!IS_TAURI) return

    let intervalId: number | null = null
    let unlisten1: (() => void) | null = null
    let unlisten2: (() => void) | null = null
    let done = false

    // Transition function — whichever path wins (event or poll) calls this once.
    const goReady = () => {
      if (done) return
      done = true
      if (intervalId !== null) clearInterval(intervalId)
      setPhase('ready')
    }

    // Fallback: poll health directly in case the Rust event fires before
    // the React listener is registered (race condition on fast backends).
    intervalId = window.setInterval(async () => {
      try {
        const r = await fetch('http://localhost:8000/health')
        if (r.ok) goReady()
      } catch {
        // not ready yet — keep polling
      }
    }, 2000)

    // Primary path: Tauri event from Rust once health check passes.
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('status-update', (e) => setStatus(e.payload)).then((f) => { unlisten1 = f })
      listen<void>('backend-ready', () => goReady()).then((f) => { unlisten2 = f })
    })

    return () => {
      done = true
      if (intervalId !== null) clearInterval(intervalId)
      unlisten1?.()
      unlisten2?.()
    }
  }, [])

  if (phase === 'loading') {
    return <SplashScreen statusText={status} />
  }

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <Sidebar current={page} onNavigate={setPage} />
      <main className="flex-1 overflow-auto">
        {page === 'chat'     && <ChatPage />}
        {page === 'training' && <TrainingPage />}
        {page === 'data'     && <DataPage />}
        {page === 'health'   && <HealthPage />}
      </main>
    </div>
  )
}
