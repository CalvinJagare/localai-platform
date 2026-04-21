import { useState, useEffect } from 'react'
import { API } from '../lib/server'

interface SettingDef {
  key: string
  label: string
  description: string
  href: string
  used_by: string
}

interface PathDef {
  key: string
  label: string
  description: string
  default: string
}

const SETTING_DEFS: SettingDef[] = [
  {
    key: 'BRAVE_API_KEY',
    label: 'Brave Search API Key',
    description: 'Required for the Web Search tool. Free tier includes 2,000 queries/month.',
    href: 'https://brave.com/search/api/',
    used_by: 'Web Search',
  },
  {
    key: 'OPENWEATHER_API_KEY',
    label: 'OpenWeatherMap API Key',
    description: 'Required for the Weather tool. Free tier covers current conditions for any city worldwide.',
    href: 'https://openweathermap.org/api',
    used_by: 'Weather',
  },
]

const PATH_DEFS: PathDef[] = [
  {
    key: 'DATA_ROOT',
    label: 'Data Root',
    description: 'Base directory for training data, models, jobs, profiles, and RAG documents.',
    default: '/app/data',
  },
  {
    key: 'HF_CACHE_PATH',
    label: 'HuggingFace Cache',
    description: 'Where the base model weights are cached. The Phi-3 model must exist here.',
    default: '/mnt/d/hf-cache',
  },
  {
    key: 'OLLAMA_MODELS_PATH',
    label: 'Ollama Models',
    description: 'Where Ollama stores model files (GGUF blobs). Passed as OLLAMA_MODELS env var.',
    default: '/mnt/d/ollama-models',
  },
  {
    key: 'LLAMA_CPP_PATH',
    label: 'llama.cpp Directory',
    description: 'Root of the llama.cpp repo — must contain convert_hf_to_gguf.py.',
    default: '/mnt/d/llama.cpp',
  },
]

export default function SettingsPage() {
  const [masked, setMasked]     = useState<Record<string, string>>({})
  const [active, setActive]     = useState<Record<string, string>>({})
  const [inputs, setInputs]     = useState<Record<string, string>>({})
  const [saving, setSaving]         = useState(false)
  const [saved, setSaved]           = useState(false)
  const [pathsSaved, setPathsSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [restartMsg, setRestartMsg] = useState<string | null>(null)
  const [error, setError]           = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/settings`)
      .then(r => r.json())
      .then((data: Record<string, string>) => setMasked(data))
      .catch(() => {})
    fetch(`${API}/config`)
      .then(r => r.json())
      .then((data: Record<string, string>) => setActive(data))
      .catch(() => {})
  }, [])

  async function restartBackend() {
    setRestarting(true)
    setRestartMsg(null)
    try {
      await fetch(`${API}/restart`, { method: 'POST' })
    } catch { /* expected — connection drops as process restarts */ }

    // Poll /health until the backend is back (max 30s)
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })
        if (r.ok) {
          // Refresh active paths from the newly started backend
          const cfg = await fetch(`${API}/config`).then(r => r.json()).catch(() => ({}))
          setActive(cfg)
          setPathsSaved(false)
          setRestartMsg('online')
          setTimeout(() => setRestartMsg(null), 4000)
          setRestarting(false)
          return
        }
      } catch { /* still starting up */ }
    }
    setRestartMsg('timeout')
    setRestarting(false)
  }

  async function saveApiKeys() {
    const apiInputs = Object.fromEntries(
      Object.entries(inputs).filter(([k]) => !PATH_DEFS.find(p => p.key === k))
    )
    if (Object.keys(apiInputs).length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const resp = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: apiInputs }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const refreshed = await fetch(`${API}/settings`).then(r => r.json())
      setMasked(refreshed)
      setInputs(prev => {
        const next = { ...prev }
        Object.keys(apiInputs).forEach(k => delete next[k])
        return next
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  async function savePaths() {
    const pathInputs = Object.fromEntries(
      Object.entries(inputs).filter(([k]) => PATH_DEFS.find(p => p.key === k) && inputs[k]?.trim())
    )
    if (Object.keys(pathInputs).length === 0) return
    setSaving(true)
    setError(null)
    setPathsSaved(false)
    try {
      const resp = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: pathInputs }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const refreshed = await fetch(`${API}/settings`).then(r => r.json())
      setMasked(refreshed)
      setInputs(prev => {
        const next = { ...prev }
        Object.keys(pathInputs).forEach(k => delete next[k])
        return next
      })
      setPathsSaved(true)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const hasApiChanges = Object.entries(inputs).some(
    ([k, v]) => !PATH_DEFS.find(p => p.key === k) && v.trim()
  )
  const hasPathChanges = Object.entries(inputs).some(
    ([k, v]) => PATH_DEFS.find(p => p.key === k) && v.trim()
  )
  const dataRootChanging =
    (inputs['DATA_ROOT'] ?? '').trim() !== '' &&
    (inputs['DATA_ROOT'] ?? '').trim() !== (active['DATA_ROOT'] ?? '')

  return (
    <div className="p-8 max-w-2xl mx-auto space-y-10">
      <div>
        <h2 className="text-xl font-semibold mb-1">Settings</h2>
        <p className="text-sm text-gray-400">
          API keys and global configuration. Values are stored locally — never sent anywhere except their respective APIs.
        </p>
      </div>

      {error && (
        <div className="p-3 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">{error}</div>
      )}

      {/* API Keys */}
      <section>
        <h3 className="text-sm font-semibold text-gray-300 mb-3 uppercase tracking-wider">API Keys</h3>
        <div className="space-y-4">
          {SETTING_DEFS.map(def => {
            const currentMasked = masked[def.key]
            const isConfigured  = Boolean(currentMasked)

            return (
              <div key={def.key} className="p-4 bg-gray-900 border border-gray-800 rounded-xl space-y-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-200">{def.label}</p>
                      <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                        isConfigured
                          ? 'bg-green-900/50 text-green-400 border border-green-800'
                          : 'bg-gray-800 text-gray-500'
                      }`}>
                        {isConfigured ? '✓ configured' : 'not set'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-1">{def.description}</p>
                    <a
                      href={def.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
                    >
                      Get API key →
                    </a>
                  </div>
                  <span className="text-xs text-gray-500 shrink-0 mt-0.5">Used by: {def.used_by}</span>
                </div>

                {isConfigured && (
                  <p className="text-xs font-mono text-gray-500">{currentMasked}</p>
                )}

                <input
                  type="password"
                  value={inputs[def.key] ?? ''}
                  onChange={e => setInputs(prev => ({ ...prev, [def.key]: e.target.value }))}
                  placeholder={isConfigured ? 'Enter new value to replace…' : 'Paste API key…'}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                />
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={saveApiKeys}
            disabled={!hasApiChanges || saving}
            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          {saved && <span className="text-sm text-green-400">✓ Saved</span>}
        </div>
      </section>

      {/* Storage Paths */}
      <section>
        <h3 className="text-sm font-semibold text-gray-300 mb-1 uppercase tracking-wider">Storage & Paths</h3>
        <p className="text-xs text-gray-500 mb-4">
          These paths are read at backend startup. Changes take effect after restarting the backend.
        </p>

        <div className="space-y-3">
          {PATH_DEFS.map(def => {
            const savedValue  = masked[def.key] ?? ''
            const activeValue = active[def.key] ?? ''
            const inputValue  = inputs[def.key] ?? ''
            const hasPendingChange = inputValue.trim() && inputValue.trim() !== activeValue

            return (
              <div key={def.key} className="p-4 bg-gray-900 border border-gray-800 rounded-xl space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-gray-200">{def.label}</p>
                  {hasPendingChange && (
                    <span className="text-xs px-1.5 py-0.5 bg-amber-900/40 text-amber-400 border border-amber-800 rounded font-medium shrink-0">
                      unsaved
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500">{def.description}</p>

                {activeValue && (
                  <p className="text-xs font-mono text-gray-500">
                    <span className="text-gray-500">active now: </span>{activeValue}
                  </p>
                )}
                {savedValue && savedValue !== activeValue && (
                  <p className="text-xs font-mono text-amber-600">
                    <span className="text-gray-500">saved (pending restart): </span>{savedValue}
                  </p>
                )}

                <input
                  type="text"
                  value={inputValue}
                  onChange={e => setInputs(prev => ({ ...prev, [def.key]: e.target.value }))}
                  placeholder={activeValue || def.default}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                />
              </div>
            )
          })}
        </div>

        {dataRootChanging && (
          <div className="mt-4 p-3 bg-amber-950/50 border border-amber-700 rounded-xl text-sm text-amber-300 space-y-1">
            <p className="font-medium">Existing data will not be moved automatically.</p>
            <p className="text-amber-400/80 text-xs">
              Profiles, training files, models, and documents currently at <span className="font-mono">{active['DATA_ROOT']}</span> will
              stay there. Copy that folder to the new path before restarting, or you'll start with a blank slate.
            </p>
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <button
            onClick={savePaths}
            disabled={!hasPathChanges || saving}
            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
          >
            {saving ? 'Saving…' : 'Save Paths'}
          </button>

          <button
            onClick={restartBackend}
            disabled={restarting || saving}
            className="px-5 py-2.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-gray-200 text-sm font-medium rounded-xl transition-colors"
          >
            {restarting ? '⟳ Restarting…' : '↺ Restart Backend'}
          </button>

          {pathsSaved && !restarting && (
            <span className="text-sm text-amber-400">⚠ Restart to apply path changes</span>
          )}
          {restartMsg === 'online' && (
            <span className="text-sm text-green-400">✓ Backend back online</span>
          )}
          {restartMsg === 'timeout' && (
            <span className="text-sm text-red-400">Backend did not respond in 30s</span>
          )}
        </div>
      </section>
    </div>
  )
}
