import type { Page, Profile } from '../App'
import { getApi } from '../lib/server'
import ProfileSelector from './ProfileSelector'
import OnboardingChecklist, { type OnboardingProgress } from './OnboardingChecklist'

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

const links: { id: Page; label: string; icon: string }[] = [
  { id: 'chat',         label: 'Chat',         icon: '💬' },
  { id: 'training',     label: 'Training',     icon: '🧠' },
  { id: 'instructions', label: 'Instructions', icon: '📋' },
  { id: 'documents',    label: 'Documents',    icon: '📄' },
  { id: 'data',         label: 'Data',         icon: '🗂️' },
  { id: 'profiles',     label: 'Profiles',     icon: '👤' },
  { id: 'models',       label: 'Models',       icon: '🤖' },
  { id: 'health',       label: 'Health',       icon: '📊' },
  { id: 'settings',     label: 'Settings',     icon: '⚙️'  },
]

export default function Sidebar({ current, onNavigate, profiles, selectedProfileId, onSelectProfile, onProfilesChange, onboardingProgress, onOnboardingDismiss }: Props) {
  return (
    <aside className="w-52 bg-gray-900 border-r border-gray-800 flex flex-col">
      {/* data-tauri-drag-region: allows dragging the frameless window from this header area */}
      <div data-tauri-drag-region className="px-4 py-4 border-b border-gray-800 cursor-default">
        <h1 className="text-lg font-bold text-white pointer-events-none">skAIler</h1>
        <p className="text-xs text-gray-400 mt-0.5 pointer-events-none">Platform</p>
      </div>

      <ProfileSelector
        profiles={profiles}
        selectedProfileId={selectedProfileId}
        onSelectProfile={onSelectProfile}
        onProfilesChange={onProfilesChange}
      />

      <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
        {links.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
              ${current === id
                ? 'bg-indigo-600 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </nav>

      {/* Onboarding checklist — shown until dismissed */}
      {onboardingProgress && (
        <OnboardingChecklist
          progress={onboardingProgress}
          onNavigate={onNavigate}
          onDismiss={onOnboardingDismiss}
        />
      )}

      <div className="px-4 py-3 border-t border-gray-800 text-xs text-gray-600 truncate">
        {getApi()}
      </div>
    </aside>
  )
}
