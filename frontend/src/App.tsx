import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import SplashScreen from './components/SplashScreen'
import ChatPage from './pages/ChatPage'
import TrainingPage from './pages/TrainingPage'
import DataPage from './pages/DataPage'
import ProfilesPage from './pages/ProfilesPage'
import HealthPage from './pages/HealthPage'

export const API = 'http://localhost:8000'

export type Page = 'chat' | 'training' | 'data' | 'profiles' | 'health'

export type ProfileColor = 'indigo' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'teal'

export interface Profile {
  id: string
  slug: string
  display_name: string
  color: ProfileColor
  current_model: string | null
  job_count: number
  created_at: string
}

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export default function App() {
  const [page, setPage]     = useState<Page>('chat')
  const [phase, setPhase]   = useState<'loading' | 'ready'>(IS_TAURI ? 'loading' : 'ready')
  const [status, setStatus] = useState('Initialising…')

  const [profiles, setProfiles]             = useState<Profile[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => localStorage.getItem('selected_profile') ?? ''
  )

  // Load profiles once backend is ready
  useEffect(() => {
    if (phase !== 'ready') return
    fetch(`${API}/profiles`)
      .then(r => r.json())
      .then((data: Profile[]) => {
        setProfiles(data)
        if (!selectedProfileId && data.length > 0)
          selectProfile(data[0].id)
      })
      .catch(() => {})
  }, [phase])

  const selectProfile = (id: string) => {
    setSelectedProfileId(id)
    localStorage.setItem('selected_profile', id)
  }

  const selectedProfile = profiles.find(p => p.id === selectedProfileId) ?? null

  // Tauri splash / event wiring
  useEffect(() => {
    if (!IS_TAURI) return

    let intervalId: number | null = null
    let unlisten1: (() => void) | null = null
    let unlisten2: (() => void) | null = null
    let done = false

    const goReady = () => {
      if (done) return
      done = true
      if (intervalId !== null) clearInterval(intervalId)
      setPhase('ready')
    }

    intervalId = window.setInterval(async () => {
      try {
        const r = await fetch('http://localhost:8000/health')
        if (r.ok) goReady()
      } catch {
        // not ready yet
      }
    }, 2000)

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
      <Sidebar
        current={page}
        onNavigate={setPage}
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={selectProfile}
        onProfilesChange={setProfiles}
      />
      <main className="flex-1 overflow-auto">
        {page === 'chat'      && <ChatPage profile={selectedProfile} />}
        {page === 'training'  && (
          <TrainingPage
            profile={selectedProfile}
            onProfileUpdate={(updated) =>
              setProfiles(ps => ps.map(p => p.id === updated.id ? updated : p))
            }
          />
        )}
        {page === 'data'      && <DataPage />}
        {page === 'profiles'  && (
          <ProfilesPage
            profiles={profiles}
            onProfilesChange={setProfiles}
            onSelectProfile={selectProfile}
          />
        )}
        {page === 'health'    && <HealthPage />}
      </main>
    </div>
  )
}
