import { useState, useEffect } from 'react'
import { API } from '../lib/server'
import type { Profile, ProfileColor } from '../App'
import { useToast } from '../components/Toast'

const DOT: Record<ProfileColor, string> = {
  indigo:  'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  violet:  'bg-violet-500',
  sky:     'bg-sky-500',
  teal:    'bg-teal-500',
}

interface ModelInfo {
  name: string
  size_bytes: number
  modified_at: string
  profile: { id: string; display_name: string; color: ProfileColor } | null
}

interface Props {
  profiles: Profile[]
  onProfilesChange: (profiles: Profile[]) => void
}

function fmtSize(bytes: number): string {
  if (bytes === 0) return '—'
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e9).toFixed(1)} GB`
}

export default function ModelsPage({ profiles, onProfilesChange }: Props) {
  const [models, setModels]       = useState<ModelInfo[]>([])
  const [loading, setLoading]     = useState(true)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const { addToast } = useToast()

  async function fetchModels() {
    setLoading(true)
    try {
      const resp = await fetch(`${API}/models`)
      if (!resp.ok) throw new Error(resp.statusText)
      setModels(await resp.json())
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchModels() }, [])

  async function deleteModel(name: string) {
    if (!window.confirm(`Delete model "${name}" from Ollama?\n\nThis removes the GGUF file. Any profile using this model will need to be retrained.`)) return
    setDeletingId(name)
    setError(null)
    try {
      const resp = await fetch(`${API}/models/${encodeURIComponent(name)}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      addToast('success', `Deleted ${name}`)
      // Update profiles locally so the model badge disappears immediately
      onProfilesChange(profiles.map(p => p.current_model === name ? { ...p, current_model: null } : p))
      setModels(prev => prev.filter(m => m.name !== name))
    } catch (err) {
      setError(String(err))
      addToast('error', `Failed to delete ${name}`)
    } finally {
      setDeletingId(null)
    }
  }

  const totalSize = models.reduce((s, m) => s + m.size_bytes, 0)

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Models</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            All models registered in Ollama · {fmtSize(totalSize)} total
          </p>
        </div>
        <button
          onClick={fetchModels}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          ↺ Refresh
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-950 border border-red-700 rounded-lg text-sm text-red-300">{error}</div>
      )}

      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : models.length === 0 ? (
        <p className="text-center text-gray-600 py-16 text-sm">No models in Ollama yet — train and merge a profile first.</p>
      ) : (
        <div className="space-y-2">
          {models.map(m => (
            <div key={m.name} className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-xl">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-mono text-sm text-gray-200">{m.name}</p>
                  {m.profile && (
                    <span className="flex items-center gap-1.5 px-2 py-0.5 bg-gray-800 rounded-full text-xs text-gray-300">
                      <span className={`w-2 h-2 rounded-full ${DOT[m.profile.color]}`} />
                      {m.profile.display_name}
                    </span>
                  )}
                  {!m.profile && (
                    <span className="px-2 py-0.5 bg-gray-800 text-gray-600 rounded-full text-xs">unlinked</span>
                  )}
                </div>
                <p className="text-xs text-gray-600 mt-0.5">
                  {fmtSize(m.size_bytes)}
                  {m.modified_at && (
                    <> · {new Date(m.modified_at).toLocaleDateString()}</>
                  )}
                </p>
              </div>
              <button
                onClick={() => deleteModel(m.name)}
                disabled={deletingId === m.name}
                title="Remove from Ollama"
                className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors text-sm disabled:opacity-40 shrink-0"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
