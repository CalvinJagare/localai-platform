import { useState, useEffect } from 'react'
import type { Page } from '../App'

export interface OnboardingProgress {
  profile:  boolean
  data:     boolean
  training: boolean
  chat:     boolean
}

interface Props {
  progress:   OnboardingProgress
  onNavigate: (p: Page) => void
  onDismiss:  () => void
}

const ITEMS: { key: keyof OnboardingProgress; label: string; page: Page; hint: string }[] = [
  { key: 'profile',  label: 'Create your first profile', page: 'profiles', hint: '→ Profiles' },
  { key: 'data',     label: 'Add training data',         page: 'data',     hint: '→ Data'     },
  { key: 'training', label: 'Run your first training',   page: 'training', hint: '→ Training' },
  { key: 'chat',     label: 'Chat with your model',      page: 'chat',     hint: '→ Chat'     },
]

export default function OnboardingChecklist({ progress, onNavigate, onDismiss }: Props) {
  const [expanded, setExpanded] = useState(true)

  const done  = ITEMS.filter(i => progress[i.key]).length
  const total = ITEMS.length
  const allDone = done === total

  // Auto-dismiss 3 s after all items complete
  useEffect(() => {
    if (!allDone) return
    const t = setTimeout(onDismiss, 3000)
    return () => clearTimeout(t)
  }, [allDone, onDismiss])

  return (
    <div className="border-t border-gray-800 px-3 py-3">
      {/* Header row */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(e => !e)}
          className="flex items-center gap-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
        >
          <span className={`transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}>▾</span>
          {allDone ? (
            <span className="text-green-400">You're all set!</span>
          ) : (
            <span>Getting started <span className="text-gray-600 font-normal">({done}/{total})</span></span>
          )}
        </button>
        <button
          onClick={onDismiss}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
        >
          Dismiss
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-gray-800 rounded-full overflow-hidden mb-2">
        <div
          className="h-full bg-indigo-500 rounded-full transition-all duration-500"
          style={{ width: `${(done / total) * 100}%` }}
        />
      </div>

      {/* Items */}
      {expanded && (
        <ul className="space-y-1.5 mt-2">
          {ITEMS.map(({ key, label, page, hint }) => {
            const checked = progress[key]
            return (
              <li key={key} className="flex items-center gap-2">
                <span className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 transition-colors ${
                  checked
                    ? 'bg-indigo-600 border-indigo-500 text-white'
                    : 'border-gray-600'
                }`}>
                  {checked && <span className="text-[9px] leading-none">✓</span>}
                </span>
                <span className={`text-xs flex-1 ${checked ? 'text-gray-600 line-through' : 'text-gray-300'}`}>
                  {label}
                </span>
                {!checked && (
                  <button
                    onClick={() => onNavigate(page)}
                    className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors shrink-0"
                  >
                    {hint}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
