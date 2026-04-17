import { useState, useEffect, useCallback } from 'react'

const API = 'http://localhost:8000'

interface HealthData {
  ollama: { reachable: boolean; models: string[] }
  system: {
    cpu_percent: number
    ram_total_gb: number
    ram_used_gb: number
    ram_percent: number
  }
  gpu: string | null
}

export default function HealthPage() {
  const [data, setData] = useState<HealthData | null>(null)
  const [loading, setLoading] = useState(false)
  const [lastFetched, setLastFetched] = useState<string | null>(null)

  const fetchHealth = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch(`${API}/health`)
      setData(await resp.json())
      setLastFetched(new Date().toLocaleTimeString())
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchHealth() }, [fetchHealth])

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">System Health</h2>
          {lastFetched && <p className="text-xs text-gray-500 mt-0.5">Last updated: {lastFetched}</p>}
        </div>
        <button
          onClick={fetchHealth}
          disabled={loading}
          className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>

      {!data && !loading && (
        <p className="text-center text-gray-500 mt-16 text-sm">Could not reach backend.</p>
      )}

      {data && (
        <div className="space-y-5">
          {/* Ollama */}
          <Card title="Ollama">
            <div className="flex items-center gap-2 mb-3">
              <span className={`w-2.5 h-2.5 rounded-full ${data.ollama.reachable ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-sm font-medium">
                {data.ollama.reachable ? 'Running' : 'Unreachable'}
              </span>
            </div>
            {data.ollama.models.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs text-gray-400 mb-2">Available models ({data.ollama.models.length})</p>
                {data.ollama.models.map((m) => (
                  <div key={m} className="flex items-center gap-2 text-sm bg-gray-800 px-3 py-2 rounded-lg">
                    <span className="text-indigo-400">⬡</span>
                    <span className="font-mono text-gray-200">{m}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-gray-500">No models pulled yet.</p>
            )}
          </Card>

          {/* CPU / RAM */}
          <Card title="System Resources">
            <div className="space-y-4">
              <Meter label="CPU" percent={data.system.cpu_percent} />
              <Meter
                label={`RAM  ${data.system.ram_used_gb} / ${data.system.ram_total_gb} GB`}
                percent={data.system.ram_percent}
              />
            </div>
          </Card>

          {/* GPU */}
          <Card title="GPU">
            {data.gpu ? (
              <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap bg-gray-800 p-3 rounded-lg">
                {data.gpu}
              </pre>
            ) : (
              <p className="text-sm text-gray-500">No NVIDIA GPU detected (or nvidia-smi unavailable).</p>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-4">{title}</h3>
      {children}
    </div>
  )
}

function Meter({ label, percent }: { label: string; percent: number }) {
  const color = percent > 80 ? 'bg-red-500' : percent > 50 ? 'bg-yellow-500' : 'bg-green-500'
  return (
    <div>
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-gray-300">{label}</span>
        <span className="text-gray-400 font-mono">{percent.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}
