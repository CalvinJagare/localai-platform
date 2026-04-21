import { useState, useEffect } from 'react'
import { API } from '../lib/server'
import type { Profile, ProfileColor } from '../App'

interface ToolInfo {
  id: string
  name: string
  description: string
  requires_key: string | null
  key_configured: boolean
}

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
  onProfilesChange: (profiles: Profile[]) => void
  onSelectProfile: (id: string) => void
}

export default function ProfilesPage({ profiles, onProfilesChange, onSelectProfile }: Props) {
  const [editingId, setEditingId]   = useState<string | null>(null)
  const [editName, setEditName]     = useState('')
  const [editBase, setEditBase]     = useState<string | null>(null)
  const [editTools, setEditTools]   = useState<string[]>([])
  const [savingId, setSavingId]     = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)
  const [availableTools, setAvailableTools] = useState<ToolInfo[]>([])

  // New profile form
  const [creating, setCreating]   = useState(false)
  const [newName, setNewName]     = useState('')
  const [newColor, setNewColor]   = useState<ProfileColor>('indigo')
  const [newBase, setNewBase]     = useState<string | null>(null)
  const [newTools, setNewTools]   = useState<string[]>([])
  const [saving, setSaving]       = useState(false)

  useEffect(() => {
    fetch(`${API}/tools`).then(r => r.json()).then(setAvailableTools).catch(() => {})
  }, [])

  function startEdit(p: Profile) {
    setEditingId(p.id)
    setEditName(p.display_name)
    setEditBase(p.base_profile_id ?? null)
    setEditTools(p.enabled_tools ?? [])
    setError(null)
  }

  function toggleTool(toolId: string, current: string[], setter: (t: string[]) => void) {
    setter(current.includes(toolId) ? current.filter(t => t !== toolId) : [...current, toolId])
  }

  async function saveEdit(id: string) {
    if (!editName.trim()) return
    setSavingId(id)
    try {
      const resp = await fetch(`${API}/profiles/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: editName.trim(), base_profile_id: editBase, enabled_tools: editTools }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const updated: Profile = await resp.json()
      onProfilesChange(profiles.map(p => p.id === id ? { ...p, ...updated } : p))
      setEditingId(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setSavingId(null)
    }
  }

  async function deleteProfile(id: string) {
    const p = profiles.find(pr => pr.id === id)
    const msg = p?.job_count
      ? `Delete "${p.display_name}"? Training history for this profile will be unlinked. Models in Ollama will NOT be removed.`
      : `Delete "${p?.display_name}"?`
    if (!window.confirm(msg)) return

    setDeletingId(id)
    setError(null)
    try {
      const resp = await fetch(`${API}/profiles/${id}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const remaining = profiles.filter(p => p.id !== id)
      onProfilesChange(remaining)
      if (remaining.length > 0) onSelectProfile(remaining[0].id)
    } catch (err) {
      setError(String(err))
    } finally {
      setDeletingId(null)
    }
  }

  async function createProfile() {
    if (!newName.trim()) return
    setSaving(true)
    setError(null)
    try {
      const resp = await fetch(`${API}/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: newName.trim(), color: newColor, base_profile_id: newBase, enabled_tools: newTools }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const created: Profile = await resp.json()
      onProfilesChange([...profiles, created])
      onSelectProfile(created.id)
      setCreating(false)
      setNewName('')
      setNewBase(null)
      setNewTools([])
      setNewColor(COLORS[profiles.length % COLORS.length])
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  // Profiles that can serve as a base (any except the one being edited)
  function baseOptions(excludeId?: string) {
    return profiles.filter(p => p.id !== excludeId)
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Profiles</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Each profile has its own trained model and chat history.
          </p>
        </div>
        {!creating && (
          <button
            onClick={() => { setCreating(true); setNewBase(null); setNewColor(COLORS[profiles.length % COLORS.length]) }}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            + New profile
          </button>
        )}
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-950 border border-red-700 rounded-lg text-sm text-red-300">{error}</div>
      )}

      {/* New profile form */}
      {creating && (
        <div className="mb-4 p-4 bg-gray-900 border border-gray-700 rounded-xl space-y-3">
          <p className="text-sm font-medium text-gray-200">New profile</p>
          <input
            autoFocus
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') createProfile(); if (e.key === 'Escape') { setCreating(false); setNewName('') } }}
            placeholder="e.g. Sales, HR, Support…"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-400 mr-1">Color</span>
            {COLORS.map(c => (
              <button
                key={c}
                onClick={() => setNewColor(c)}
                className={`w-6 h-6 rounded-full ${DOT[c]} ${newColor === c ? `ring-2 ring-offset-2 ring-offset-gray-900 ${RING[c]}` : ''} transition-all`}
              />
            ))}
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Base profile <span className="text-gray-500">(optional — inherit shared training)</span></label>
            <BaseSelect value={newBase} onChange={setNewBase} options={profiles} />
          </div>
          <ToolToggles tools={availableTools} enabled={newTools} onChange={t => toggleTool(t, newTools, setNewTools)} />
          <div className="flex gap-2">
            <button
              onClick={createProfile}
              disabled={!newName.trim() || saving}
              className="flex-1 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-white font-medium transition-colors"
            >
              {saving ? 'Creating…' : 'Create'}
            </button>
            <button
              onClick={() => { setCreating(false); setNewName('') }}
              className="flex-1 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Profile cards */}
      <div className="space-y-3">
        {profiles.map(p => {
          const baseName = p.base_profile_id
            ? profiles.find(x => x.id === p.base_profile_id)?.display_name
            : null

          return (
            <div key={p.id} className="p-4 bg-gray-900 border border-gray-800 rounded-xl">
              <div className="flex items-start gap-3">
                <span className={`w-3 h-3 rounded-full mt-1 flex-shrink-0 ${DOT[p.color]}`} />

                <div className="flex-1 min-w-0">
                  {editingId === p.id ? (
                    <div className="space-y-2">
                      <input
                        autoFocus
                        value={editName}
                        onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Escape') setEditingId(null) }}
                        className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2 py-1 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                      <div>
                        <label className="text-xs text-gray-400 block mb-1">Base profile</label>
                        <BaseSelect value={editBase} onChange={setEditBase} options={baseOptions(p.id)} />
                      </div>
                      <ToolToggles tools={availableTools} enabled={editTools} onChange={t => toggleTool(t, editTools, setEditTools)} />
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEdit(p.id)}
                          disabled={!editName.trim() || savingId === p.id}
                          className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded text-white transition-colors"
                        >
                          {savingId === p.id ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingId(null)}
                          className="px-3 py-1 text-xs bg-gray-700 hover:bg-gray-600 rounded text-gray-300 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="font-medium text-gray-100">{p.display_name}</p>
                  )}

                  {editingId !== p.id && (
                    <div className="mt-1.5 space-y-0.5 text-xs text-gray-500">
                      {p.current_model ? (
                        <p>Model: <span className="font-mono text-gray-400">{p.current_model}</span></p>
                      ) : (
                        <p className="text-gray-500">No model trained yet</p>
                      )}
                      {baseName && (
                        <p>Base: <span className="text-gray-400">{baseName}</span></p>
                      )}
                      {p.enabled_tools?.length > 0 && (
                        <div className="flex gap-1 flex-wrap pt-0.5">
                          {p.enabled_tools.map(tid => {
                            const tool = availableTools.find(t => t.id === tid)
                            return (
                              <span key={tid} className={`px-1.5 py-0.5 rounded text-xs font-medium ${tool?.key_configured === false ? 'bg-amber-900/40 text-amber-500' : 'bg-indigo-900/40 text-indigo-400'}`}>
                                {tool?.name ?? tid}
                              </span>
                            )
                          })}
                        </div>
                      )}
                      <p>{p.job_count} training {p.job_count === 1 ? 'job' : 'jobs'}</p>
                      <p className="font-mono text-gray-500">slug: {p.slug}</p>
                    </div>
                  )}
                </div>

                {editingId !== p.id && (
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      onClick={() => startEdit(p)}
                      title="Edit"
                      className="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-800 rounded-lg transition-colors text-sm"
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => deleteProfile(p.id)}
                      disabled={deletingId === p.id}
                      title="Delete"
                      className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors text-sm disabled:opacity-40"
                    >
                      🗑
                    </button>
                  </div>
                )}
              </div>
            </div>
          )
        })}

        {profiles.length === 0 && (
          <p className="text-center text-gray-500 py-12 text-sm">No profiles yet — create one above.</p>
        )}
      </div>
    </div>
  )
}

function ToolToggles({ tools, enabled, onChange }: {
  tools: ToolInfo[]
  enabled: string[]
  onChange: (id: string) => void
}) {
  if (tools.length === 0) return null
  return (
    <div>
      <label className="text-xs text-gray-400 block mb-1.5">Tools</label>
      <div className="space-y-1.5">
        {tools.map(tool => {
          const isOn = enabled.includes(tool.id)
          const needsKey = tool.requires_key !== null && !tool.key_configured
          return (
            <label key={tool.id} className={`flex items-start gap-2.5 p-2 rounded-lg cursor-pointer transition-colors ${isOn ? 'bg-indigo-900/20' : 'hover:bg-gray-800'}`}>
              <input
                type="checkbox"
                checked={isOn}
                onChange={() => onChange(tool.id)}
                className="mt-0.5 accent-indigo-500"
              />
              <div className="min-w-0">
                <span className="text-xs font-medium text-gray-300">{tool.name}</span>
                {needsKey && (
                  <span className="ml-1.5 text-xs text-amber-500">⚠ API key required</span>
                )}
                <p className="text-xs text-gray-500 mt-0.5">{tool.description}</p>
              </div>
            </label>
          )
        })}
      </div>
      <p className="mt-2 text-xs text-gray-500">Want a new tool? Just ask Claude Code — new tools take ~5 minutes to add.</p>
    </div>
  )
}

function BaseSelect({ value, onChange, options }: {
  value: string | null
  onChange: (id: string | null) => void
  options: Profile[]
}) {
  return (
    <select
      value={value ?? ''}
      onChange={e => onChange(e.target.value || null)}
      className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="">None (start from Phi-3-mini)</option>
      {options.map(p => (
        <option key={p.id} value={p.id}>
          {p.display_name}{p.current_model ? '' : ' (no model yet)'}
        </option>
      ))}
    </select>
  )
}
