import { useState, useEffect, useCallback, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import SplashScreen from './components/SplashScreen'
import ChatPage from './pages/ChatPage'
import TrainingPage from './pages/TrainingPage'
import DataPage from './pages/DataPage'
import ProfilesPage from './pages/ProfilesPage'
import InstructionsPage from './pages/InstructionsPage'
import SettingsPage from './pages/SettingsPage'
import HealthPage from './pages/HealthPage'
import DocumentsPage from './pages/DocumentsPage'
import ModelsPage from './pages/ModelsPage'
import { ToastProvider } from './components/Toast'
import SetupWizard from './components/SetupWizard'
import { type OnboardingProgress } from './components/OnboardingChecklist'
import { API, getApi, saveServerConfig } from './lib/server'

export type { ServerConfig } from './lib/server'
export type { OnboardingProgress } from './components/OnboardingChecklist'

export type Page = 'chat' | 'training' | 'data' | 'profiles' | 'instructions' | 'settings' | 'health' | 'documents' | 'models'

export type ProfileColor = 'indigo' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'teal'

export interface Profile {
  id: string
  slug: string
  display_name: string
  color: ProfileColor
  current_model: string | null
  base_profile_id: string | null
  enabled_tools: string[]
  job_count: number
  created_at: string
}

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

function loadProgress(): OnboardingProgress {
  try {
    const raw = localStorage.getItem('onboarding_progress')
    if (raw) return JSON.parse(raw)
  } catch { /* fall through */ }
  return { profile: false, data: false, training: false, chat: false }
}

export default function App() {
  const [page, setPage]           = useState<Page>('chat')
  const [phase, setPhase]         = useState<'loading' | 'ready' | 'unreachable'>(IS_TAURI ? 'loading' : 'ready')
  const [status, setStatus]       = useState('Initialising…')
  const [unreachableUrl, setUnreachableUrl] = useState('')
  const [setupDone, setSetupDone] = useState(() => localStorage.getItem('skailer_server') !== null)

  const [profiles, setProfiles]                   = useState<Profile[]>([])
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    () => localStorage.getItem('selected_profile') ?? ''
  )

  // Onboarding
  const [onboardingDone, setOnboardingDone]       = useState(() => localStorage.getItem('onboarding_done') === '1')
  const [onboardingProgress, setOnboardingProgress] = useState<OnboardingProgress>(loadProgress)

  const tickOnboarding = useCallback((key: keyof OnboardingProgress) => {
    setOnboardingProgress(prev => {
      if (prev[key]) return prev
      const next = { ...prev, [key]: true }
      localStorage.setItem('onboarding_progress', JSON.stringify(next))
      return next
    })
  }, [])

  const dismissOnboarding = useCallback(() => {
    localStorage.setItem('onboarding_done', '1')
    setOnboardingDone(true)
  }, [])

  // Derive profile tick from profiles state — no setState in effect needed
  const effectiveProgress = useMemo<OnboardingProgress>(() => ({
    ...onboardingProgress,
    profile: onboardingProgress.profile || profiles.length > 0,
  }), [onboardingProgress, profiles.length])

  const selectProfile = (id: string) => {
    setSelectedProfileId(id)
    localStorage.setItem('selected_profile', id)
  }

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
        const r = await fetch(`${getApi()}/health`)
        if (r.ok) goReady()
      } catch { /* not ready yet */ }
    }, 2000)

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen<string>('status-update',       (e) => setStatus(e.payload)).then((f) => { unlisten1 = f })
      listen<void>('backend-ready',         () => goReady()).then((f)           => { unlisten2 = f })
      listen<string>('backend-unreachable', (e) => {
        if (done) return
        done = true
        if (intervalId !== null) clearInterval(intervalId)
        setUnreachableUrl(e.payload)
        setPhase('unreachable')
      })
    })

    return () => {
      done = true
      if (intervalId !== null) clearInterval(intervalId)
      unlisten1?.()
      unlisten2?.()
    }
  }, [])

  if (phase === 'loading') return <SplashScreen statusText={status} />

  if (phase === 'ready' && !setupDone) {
    return <SetupWizard onComplete={() => { setSetupDone(true); window.location.reload() }} />
  }

  if (phase === 'unreachable') {
    return (
      <div className="flex h-screen bg-gray-950 text-gray-100 items-center justify-center">
        <div className="text-center space-y-4 max-w-sm px-6">
          <p className="text-2xl">⚠</p>
          <p className="font-semibold text-gray-100">Could not reach server</p>
          <p className="text-sm text-gray-400 font-mono break-all">{unreachableUrl}</p>
          <div className="flex gap-3 justify-center pt-2">
            <button
              onClick={() => { setPhase('loading'); setStatus('Retrying…'); window.location.reload() }}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm font-medium rounded-lg transition-colors"
            >
              Retry
            </button>
            <button
              onClick={async () => {
                const url = window.prompt('Enter server URL:', unreachableUrl)
                if (!url) return
                saveServerConfig({ type: 'remote', url })
                window.location.reload()
              }}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-sm font-medium rounded-lg transition-colors"
            >
              Change server address
            </button>
          </div>
        </div>
      </div>
    )
  }

  const showOnboarding = !onboardingDone

  return (
    <ToastProvider>
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <Sidebar
        current={page}
        onNavigate={setPage}
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={selectProfile}
        onProfilesChange={setProfiles}
        onboardingProgress={showOnboarding ? effectiveProgress : null}
        onOnboardingDismiss={dismissOnboarding}
      />
      <main className="flex-1 overflow-auto">
        {page === 'chat' && (
          <ChatPage
            profile={selectedProfile}
            onMessageSent={() => tickOnboarding('chat')}
          />
        )}
        {page === 'training' && (
          <TrainingPage
            profile={selectedProfile}
            profiles={profiles}
            onProfileUpdate={(updated) =>
              setProfiles(ps => ps.map(p => p.id === updated.id ? updated : p))
            }
            onDataAdded={() => tickOnboarding('data')}
            onTrainingStarted={() => tickOnboarding('training')}
          />
        )}
        {page === 'data'     && <DataPage onDataAdded={() => tickOnboarding('data')} />}
        {page === 'profiles' && (
          <ProfilesPage
            profiles={profiles}
            onProfilesChange={setProfiles}
            onSelectProfile={selectProfile}
          />
        )}
        {page === 'instructions' && <InstructionsPage profile={selectedProfile} />}
        {page === 'documents'    && <DocumentsPage profile={selectedProfile} />}
        {page === 'models'       && <ModelsPage profiles={profiles} onProfilesChange={setProfiles} />}
        {page === 'settings'     && <SettingsPage />}
        {page === 'health'       && <HealthPage />}
      </main>
    </div>
    </ToastProvider>
  )
}
