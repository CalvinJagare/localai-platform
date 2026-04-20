import { useState, useEffect } from 'react'
import { API } from '../App'

interface SettingDef {
  key: string
  label: string
  description: string
  href: string
  used_by: string
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

export default function SettingsPage() {
  const [masked, setMasked]   = useState<Record<string, string>>({})
  const [inputs, setInputs]   = useState<Record<string, string>>({})
  const [saving, setSaving]   = useState(false)
  const [saved, setSaved]     = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    fetch(`${API}/settings`)
      .then(r => r.json())
      .then((data: Record<string, string>) => setMasked(data))
      .catch(() => {})
  }, [])

  async function save() {
    if (Object.keys(inputs).length === 0) return
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const resp = await fetch(`${API}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: inputs }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      // Refresh masked values
      const refreshed = await fetch(`${API}/settings`).then(r => r.json())
      setMasked(refreshed)
      setInputs({})
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = Object.values(inputs).some(v => v.trim())

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Settings</h2>
      <p className="text-sm text-gray-400 mb-8">
        API keys and global configuration. Values are stored locally — never sent anywhere except their respective APIs.
      </p>

      {error && (
        <div className="mb-4 p-3 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">{error}</div>
      )}

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
                <span className="text-xs text-gray-600 shrink-0 mt-0.5">Used by: {def.used_by}</span>
              </div>

              {isConfigured && (
                <p className="text-xs font-mono text-gray-600">{currentMasked}</p>
              )}

              <input
                type="password"
                value={inputs[def.key] ?? ''}
                onChange={e => setInputs(prev => ({ ...prev, [def.key]: e.target.value }))}
                placeholder={isConfigured ? 'Enter new value to replace…' : 'Paste API key…'}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
              />
            </div>
          )
        })}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          onClick={save}
          disabled={!hasChanges || saving}
          className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span className="text-sm text-green-400">✓ Saved</span>}
      </div>
    </div>
  )
}
