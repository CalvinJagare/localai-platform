import { useState, useRef, useEffect } from 'react'
import { API, type Profile, type ProfileColor } from '../App'

const COLORS: ProfileColor[] = ['indigo', 'emerald', 'amber', 'rose', 'violet', 'sky', 'teal']

const DOT: Record<ProfileColor, string> = {
  indigo:  'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  violet:  'bg-violet-500',
  sky:     'bg-sky-500',
  teal:    'bg-teal-500',
}

const RING: Record<ProfileColor, string> = {
  indigo:  'ring-indigo-500',
  emerald: 'ring-emerald-500',
  amber:   'ring-amber-500',
  rose:    'ring-rose-500',
  violet:  'ring-violet-500',
  sky:     'ring-sky-500',
  teal:    'ring-teal-500',
}

interface Props {
  profiles: Profile[]
  selectedProfileId: string
  onSelectProfile: (id: string) => void
  onProfilesChange: (profiles: Profile[]) => void
}

export default function ProfileSelector({ profiles, selectedProfileId, onSelectProfile, onProfilesChange }: Props) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState<ProfileColor>('indigo')
  const [saving, setSaving] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const selected = profiles.find(p => p.id === selectedProfileId)

  // Close popover on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
        setCreating(false)
        setNewName('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const handleSelect = (id: string) => {
    onSelectProfile(id)
    setOpen(false)
  }

  const handleCreate = async () => {
    if (!newName.trim()) return
    setSaving(true)
    try {
      const resp = await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: newName.trim(), color: newColor }),
      })
      if (resp.ok) {
        const created: Profile = await resp.json()
        onProfilesChange([...profiles, created])
        onSelectProfile(created.id)
        setCreating(false)
        setNewName('')
        setOpen(false)
      }
    } finally {
      setSaving(false)
    }
  }

  // Next color in palette for new profiles
  const nextColor = COLORS[profiles.length % COLORS.length]
  useEffect(() => { setNewColor(nextColor) }, [profiles.length])

  return (
    <div ref={ref} className="relative px-3 py-2">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-gray-800 transition-colors text-left"
      >
        <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${selected ? DOT[selected.color] : 'bg-gray-600'}`} />
        <span className="text-sm text-gray-200 truncate flex-1">
          {selected?.display_name ?? 'Select profile'}
        </span>
        <span className="text-gray-500 text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute left-3 right-3 top-full mt-1 z-50 bg-gray-800 border border-gray-700 rounded-lg shadow-xl overflow-hidden">
          {profiles.map(p => (
            <button
              key={p.id}
              onClick={() => handleSelect(p.id)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left"
            >
              <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${DOT[p.color]}`} />
              <span className="text-sm text-gray-200 flex-1">{p.display_name}</span>
              {p.id === selectedProfileId && <span className="text-indigo-400 text-xs">✓</span>}
            </button>
          ))}

          <div className="border-t border-gray-700" />

          {creating ? (
            <div className="p-2 space-y-2">
              <input
                autoFocus
                value={newName}
                onChange={e => setNewName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
                placeholder="Profile name…"
                className="w-full bg-gray-900 border border-gray-600 rounded px-2 py-1 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-indigo-500"
              />
              <div className="flex gap-1">
                {COLORS.map(c => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className={`w-5 h-5 rounded-full ${DOT[c]} ${newColor === c ? `ring-2 ring-offset-1 ring-offset-gray-800 ${RING[c]}` : ''}`}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleCreate}
                  disabled={!newName.trim() || saving}
                  className="flex-1 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded text-white transition-colors"
                >
                  {saving ? 'Creating…' : 'Create'}
                </button>
                <button
                  onClick={() => { setCreating(false); setNewName('') }}
                  className="flex-1 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 transition-colors text-left text-sm text-gray-400 hover:text-gray-200"
            >
              <span className="text-base leading-none">+</span> New profile
            </button>
          )}
        </div>
      )}
    </div>
  )
}
