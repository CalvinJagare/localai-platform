import type { Page, Profile } from '../App'
import ProfileSelector from './ProfileSelector'
import OnboardingChecklist, { type OnboardingProgress } from './OnboardingChecklist'
import Astronaut, { type AstronautMode } from './Astronaut'

interface Props {
  current: Page
  onNavigate: (p: Page) => void
  profiles: Profile[]
  selectedProfileId: string
  onSelectProfile: (id: string) => void
  onProfilesChange: (profiles: Profile[]) => void
  onboardingProgress: OnboardingProgress | null
  onOnboardingDismiss: () => void
}

const NAV_LINKS: { id: Page; label: string; icon: string }[] = [
  { id: 'chat',         label: 'Chat',         icon: '◉' },
  { id: 'training',     label: 'Training',     icon: '◎' },
  { id: 'instructions', label: 'Instructions', icon: '◈' },
  { id: 'documents',    label: 'Documents',    icon: '◌' },
  { id: 'data',         label: 'Data',         icon: '◍' },
  { id: 'profiles',     label: 'Profiles',     icon: '◈' },
  { id: 'models',       label: 'Models',       icon: '◉' },
  { id: 'health',       label: 'Health',       icon: '◍' },
  { id: 'settings',     label: 'Settings',     icon: '⊙'  },
]

const PAGE_MODE: Partial<Record<Page, AstronautMode>> = {
  training: 'training',
  health:   'idle',
}

export default function Sidebar({
  current, onNavigate,
  profiles, selectedProfileId, onSelectProfile, onProfilesChange,
  onboardingProgress, onOnboardingDismiss,
}: Props) {
  const astronautMode: AstronautMode = PAGE_MODE[current] ?? 'idle'

  return (
    <aside className="bg-gray-900 border-r border-gray-700 flex flex-col overflow-hidden relative z-20">

      <ProfileSelector
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={onSelectProfile}
        onProfilesChange={onProfilesChange}
      />

      {/* ── Navigation ────────────────────────────────────────── */}
      <div
        className="px-5 pt-4 pb-1 text-[9px] font-mono tracking-[3px] uppercase text-gray-500"
      >
        Navigation
      </div>

      <nav className="px-2 space-y-0.5">
        {NAV_LINKS.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`nav-item w-full flex items-center gap-3 px-3 py-2.5 text-sm font-medium
              transition-colors cursor-pointer border-l-2
              ${current === id
                ? 'active border-indigo-400 text-indigo-300 bg-indigo-500/[0.08]'
                : 'border-transparent text-gray-500 hover:text-gray-100'}`}
          >
            <span className="w-4 text-center flex-shrink-0 text-[13px]">{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* ── Astronaut + onboarding checklist ─────────────────── */}
      <div className="mt-auto">
        <Astronaut mode={astronautMode} />
        {onboardingProgress && (
          <>
            <div className="px-5 pt-1 pb-1 text-[9px] font-mono tracking-[3px] uppercase text-gray-500">
              Setup
            </div>
            <div className="px-2 mb-2">
              <OnboardingChecklist
                progress={onboardingProgress}
                onNavigate={onNavigate}
                onDismiss={onOnboardingDismiss}
              />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
