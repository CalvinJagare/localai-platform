import { useState, useEffect } from 'react'
import { API, saveServerConfig } from '../lib/server'

const IS_TAURI = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type Step =
  | 'choose'
  | 'storage'
  | 'model-select'
  | 'download'
  | 'local-done'
  | 'remote-url'
  | 'remote-confirm'

interface ModelInfo { key: string; id: string; name: string; vram_gb: number; size_gb: number }
interface DiskInfo  { free_gb: number; total_gb: number }

interface Props { onComplete: () => void }

const LOCAL_STEPS  = ['Choose', 'Storage', 'Base Model', 'Download', 'Done']
const REMOTE_STEPS = ['Choose', 'Server URL', 'Confirm']

function stepIndex(step: Step): number {
  const local  = ['choose', 'storage', 'model-select', 'download', 'local-done']
  const remote = ['choose', 'remote-url', 'remote-confirm']
  const ri = remote.indexOf(step)
  return ri >= 0 ? ri : local.indexOf(step)
}

function StepDots({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div className="flex items-center gap-1.5 mb-8">
      {labels.map((label, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <div className={`flex items-center gap-1.5 ${
            i === current ? 'text-white' : i < current ? 'text-indigo-400' : 'text-gray-600'
          }`}>
            <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${
              i === current ? 'bg-indigo-600 text-white'
              : i < current ? 'bg-indigo-900 text-indigo-400'
              : 'bg-gray-800 text-gray-600'
            }`}>
              {i < current ? '✓' : i + 1}
            </span>
            <span className="text-xs hidden sm:block">{label}</span>
          </div>
          {i < labels.length - 1 && <span className="text-gray-700 text-xs">—</span>}
        </div>
      ))}
    </div>
  )
}

export default function SetupWizard({ onComplete }: Props) {
  const [step, setStep] = useState<Step>('choose')

  // Storage
  const [dataRoot,    setDataRoot]    = useState('')
  const [hfCache,     setHfCache]     = useState('')
  const [ollamaPath,  setOllamaPath]  = useState('')
  const [llamaCpp,    setLlamaCpp]    = useState('')
  const [diskInfo,    setDiskInfo]    = useState<DiskInfo | null>(null)
  const [pathsSaving, setPathsSaving] = useState(false)

  // Model selection
  const [models,        setModels]        = useState<ModelInfo[]>([])
  const [selectedModel, setSelectedModel] = useState('phi3-mini')
  const [gpuVram,       setGpuVram]       = useState<number | null>(null)

  // Download
  const [downloadPct,   setDownloadPct]   = useState(0)
  const [downloadError, setDownloadError] = useState<string | null>(null)

  // Remote
  const [remoteUrl,   setRemoteUrl]   = useState('http://')
  const [testing,     setTesting]     = useState(false)
  const [testResult,  setTestResult]  = useState<{ ok: boolean; info: string } | null>(null)

  // Load data when entering relevant steps
  useEffect(() => {
    if (step === 'storage') {
      fetch(`${API}/config`)
        .then(r => r.json())
        .then((cfg: Record<string, string>) => {
          setDataRoot(cfg.DATA_ROOT ?? '')
          setHfCache(cfg.HF_CACHE_PATH ?? '')
          setOllamaPath(cfg.OLLAMA_MODELS_PATH ?? '')
          setLlamaCpp(cfg.LLAMA_CPP_PATH ?? '')
          return fetch(`${API}/setup/disk-info?path=${encodeURIComponent(cfg.DATA_ROOT ?? '/')}`)
            .then(r => r.json())
            .then(setDiskInfo)
        })
        .catch(() => {})
    }
    if (step === 'model-select') {
      fetch(`${API}/setup/models`).then(r => r.json()).then(setModels).catch(() => {})
      fetch(`${API}/health`).then(r => r.json()).then(h => {
        // nvidia-smi output: "GPU Name, total_MB, used_MB, util%"
        const match = String(h.gpu ?? '').match(/,\s*(\d+),/)
        if (match) setGpuVram(Math.round(parseInt(match[1]) / 1024))
      }).catch(() => {})
    }
  }, [step])

  async function savePathsAndContinue() {
    setPathsSaving(true)
    try {
      const data: Record<string, string> = {}
      if (dataRoot)   data.DATA_ROOT          = dataRoot
      if (hfCache)    data.HF_CACHE_PATH       = hfCache
      if (ollamaPath) data.OLLAMA_MODELS_PATH  = ollamaPath
      if (llamaCpp)   data.LLAMA_CPP_PATH      = llamaCpp

      if (Object.keys(data).length > 0) {
        await fetch(`${API}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        })
        // Restart backend so new paths take effect before download
        try { await fetch(`${API}/restart`, { method: 'POST' }) } catch { /* drops connection */ }
        const deadline = Date.now() + 30_000
        while (Date.now() < deadline) {
          await new Promise(r => setTimeout(r, 1500))
          try {
            const r = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })
            if (r.ok) break
          } catch { /* still coming up */ }
        }
      }
      setStep('model-select')
    } finally {
      setPathsSaving(false)
    }
  }

  async function startDownload() {
    setStep('download')
    setDownloadPct(0)
    setDownloadError(null)
    try {
      const resp = await fetch(`${API}/setup/download-model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: selectedModel }),
      })
      const reader  = resp.body!.getReader()
      const decoder = new TextDecoder()
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        for (const line of decoder.decode(value).split('\n').filter(l => l.startsWith('data: '))) {
          try {
            const chunk = JSON.parse(line.slice(6))
            if (chunk.type === 'progress') setDownloadPct(chunk.pct)
            if (chunk.type === 'done')     { setDownloadPct(100); setStep('local-done'); break outer }
            if (chunk.type === 'error')    { setDownloadError(chunk.message); break outer }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (err) {
      setDownloadError(String(err))
    }
  }

  async function testConnection() {
    setTesting(true)
    setTestResult(null)
    try {
      const base = remoteUrl.replace(/\/$/, '')
      const r    = await fetch(`${base}/health`, { signal: AbortSignal.timeout(6000) })
      if (r.ok) {
        const data = await r.json()
        const gpu  = String(data.gpu ?? '').split(',')[0] || 'unknown'
        setTestResult({ ok: true, info: `GPU: ${gpu}` })
        setStep('remote-confirm')
      } else {
        setTestResult({ ok: false, info: `HTTP ${r.status}` })
      }
    } catch (err) {
      setTestResult({ ok: false, info: String(err) })
    } finally {
      setTesting(false)
    }
  }

  async function completeLocal() {
    saveServerConfig({ type: 'local', url: 'http://localhost:8000' })
    if (IS_TAURI) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('save_server_config', { mode: 'local', url: 'http://localhost:8000' }).catch(() => {})
    }
    onComplete()
  }

  async function completeRemote() {
    const url = remoteUrl.replace(/\/$/, '')
    saveServerConfig({ type: 'remote', url })
    if (IS_TAURI) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('save_server_config', { mode: 'remote', url }).catch(() => {})
    }
    onComplete()
  }

  const isRemote = ['remote-url', 'remote-confirm'].includes(step)
  const labels   = isRemote ? REMOTE_STEPS : LOCAL_STEPS
  const idx      = stepIndex(step)

  return (
    <div className="fixed inset-0 bg-gray-950 flex flex-col items-center justify-center z-50 px-4">

      {/* Brand */}
      <div className="mb-8 text-center">
        <h1 className="text-3xl font-bold tracking-tight">skAIler</h1>
        <p className="text-sm text-gray-500 mt-1">Setup wizard</p>
      </div>

      {/* Step indicator — hidden during download */}
      {step !== 'download' && <StepDots labels={labels} current={idx} />}

      {/* Panel */}
      <div className="w-full max-w-md">

        {/* ── CHOOSE ─────────────────────────────────────────────────── */}
        {step === 'choose' && (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold text-center mb-5">How do you want to run skAIler?</h2>

            {[
              {
                icon: '💻',
                title: 'New installation',
                desc: 'Run models locally on this machine. Requires a CUDA GPU and Docker.',
                onClick: () => setStep('storage'),
              },
              {
                icon: '🌐',
                title: 'Connect to existing server',
                desc: 'Connect to a skAIler server already running on another machine.',
                onClick: () => setStep('remote-url'),
              },
            ].map(({ icon, title, desc, onClick }) => (
              <button
                key={title}
                onClick={onClick}
                className="w-full p-5 bg-gray-900 hover:bg-gray-800 border border-gray-700 hover:border-indigo-500 rounded-2xl text-left transition-all group"
              >
                <div className="flex items-start gap-4">
                  <span className="text-xl mt-0.5">{icon}</span>
                  <div>
                    <p className="font-medium text-gray-100 group-hover:text-white text-sm">{title}</p>
                    <p className="text-xs text-gray-500 mt-1">{desc}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* ── STORAGE ────────────────────────────────────────────────── */}
        {step === 'storage' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1">Storage paths</h2>
              <p className="text-xs text-gray-400">Where skAIler saves models, data, and profiles. Leave blank to keep current values.</p>
            </div>

            {diskInfo && (
              <div className="flex items-center gap-2 text-xs text-gray-400 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                <span className="text-gray-600">Disk:</span>
                <span className="font-mono">{diskInfo.free_gb} GB free of {diskInfo.total_gb} GB</span>
                {diskInfo.free_gb < 20 && (
                  <span className="ml-auto text-amber-400">⚠ Low disk space</span>
                )}
              </div>
            )}

            {([
              { label: 'Data directory',       val: dataRoot,   set: setDataRoot,   ph: '/app/data' },
              { label: 'HuggingFace cache',    val: hfCache,    set: setHfCache,    ph: '/mnt/d/hf-cache' },
              { label: 'Ollama models',         val: ollamaPath, set: setOllamaPath, ph: '/mnt/d/ollama-models' },
              { label: 'llama.cpp directory',  val: llamaCpp,   set: setLlamaCpp,   ph: '/mnt/d/llama.cpp' },
            ] as const).map(({ label, val, set, ph }) => (
              <div key={label}>
                <label className="text-xs text-gray-500 mb-1 block">{label}</label>
                <input
                  type="text"
                  value={val}
                  onChange={e => (set as (v: string) => void)(e.target.value)}
                  placeholder={ph}
                  className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>
            ))}

            <div className="flex gap-3 pt-1">
              <button onClick={() => setStep('choose')} className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm rounded-xl transition-colors">
                Back
              </button>
              <button
                onClick={savePathsAndContinue}
                disabled={pathsSaving}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
              >
                {pathsSaving ? 'Applying…' : 'Next'}
              </button>
            </div>
          </div>
        )}

        {/* ── MODEL SELECT ────────────────────────────────────────────── */}
        {step === 'model-select' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1">Choose a base model</h2>
              <p className="text-xs text-gray-400">This will be fine-tuned when you train a profile.</p>
              {gpuVram !== null && (
                <p className="text-xs text-gray-500 mt-1">
                  Detected VRAM: <span className="text-gray-300 font-mono">{gpuVram} GB</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              {models.map(m => {
                const fits       = gpuVram === null || m.vram_gb <= gpuVram
                const eligible   = models.filter(x => gpuVram === null || x.vram_gb <= gpuVram)
                const recommended = fits && gpuVram !== null &&
                  m.vram_gb === Math.max(...eligible.map(x => x.vram_gb))

                return (
                  <button
                    key={m.key}
                    onClick={() => fits && setSelectedModel(m.key)}
                    disabled={!fits}
                    className={`w-full p-4 rounded-xl border text-left transition-all ${
                      selectedModel === m.key
                        ? 'bg-indigo-950/60 border-indigo-500'
                        : fits
                          ? 'bg-gray-900 border-gray-700 hover:border-gray-500'
                          : 'bg-gray-900/30 border-gray-800 opacity-40 cursor-not-allowed'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm text-gray-100">{m.name}</span>
                          {recommended && (
                            <span className="text-xs px-1.5 py-0.5 bg-indigo-900/60 text-indigo-300 border border-indigo-700/50 rounded">
                              Recommended
                            </span>
                          )}
                          {!fits && (
                            <span className="text-xs px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded">
                              Needs {m.vram_gb} GB VRAM
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                          {m.vram_gb} GB VRAM · ~{m.size_gb} GB download
                        </p>
                      </div>
                      <div className={`w-4 h-4 rounded-full border-2 shrink-0 transition-colors ${
                        selectedModel === m.key ? 'bg-indigo-500 border-indigo-400' : 'border-gray-600'
                      }`} />
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex gap-3 pt-1">
              <button onClick={() => setStep('storage')} className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm rounded-xl transition-colors">
                Back
              </button>
              <button
                onClick={startDownload}
                disabled={!selectedModel}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
              >
                Download & install
              </button>
            </div>
          </div>
        )}

        {/* ── DOWNLOAD ───────────────────────────────────────────────── */}
        {step === 'download' && (
          <div className="space-y-6 text-center">
            <div>
              <h2 className="text-lg font-semibold mb-1">Downloading base model</h2>
              <p className="text-xs text-gray-400">This may take a few minutes depending on your connection speed.</p>
            </div>

            <div className="space-y-2">
              <div className="h-2.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-700"
                  style={{ width: `${downloadPct}%` }}
                />
              </div>
              <p className="text-sm font-mono text-gray-400">{downloadPct}%</p>
            </div>

            {downloadError ? (
              <div className="p-4 bg-red-950/60 border border-red-800 rounded-xl text-left space-y-2">
                <p className="text-sm font-medium text-red-300">Download failed</p>
                <p className="text-xs font-mono text-red-400 break-all">{downloadError}</p>
                <button
                  onClick={() => setStep('model-select')}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors"
                >
                  ← Back to model selection
                </button>
              </div>
            ) : (
              <p className="text-xs text-gray-600">Do not close the app during download.</p>
            )}
          </div>
        )}

        {/* ── LOCAL DONE ─────────────────────────────────────────────── */}
        {step === 'local-done' && (
          <div className="space-y-6 text-center">
            <div>
              <p className="text-5xl mb-4">✓</p>
              <h2 className="text-lg font-semibold">Setup complete</h2>
              <p className="text-sm text-gray-400 mt-2">
                Your base model is ready. Create a profile and start training.
              </p>
            </div>
            <button
              onClick={completeLocal}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-medium rounded-xl transition-colors"
            >
              Launch skAIler
            </button>
          </div>
        )}

        {/* ── REMOTE URL ─────────────────────────────────────────────── */}
        {step === 'remote-url' && (
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-1">Server address</h2>
              <p className="text-xs text-gray-400">Enter the URL of the skAIler server you want to connect to.</p>
            </div>

            <div>
              <label className="text-xs text-gray-500 mb-1 block">Server URL</label>
              <input
                type="text"
                value={remoteUrl}
                onChange={e => { setRemoteUrl(e.target.value); setTestResult(null) }}
                placeholder="http://192.168.1.100:8000"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                onKeyDown={e => e.key === 'Enter' && testConnection()}
              />
            </div>

            {testResult && !testResult.ok && (
              <div className="p-3 bg-red-950/60 border border-red-800 rounded-lg text-sm text-red-300">
                Could not connect: <span className="font-mono">{testResult.info}</span>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={() => setStep('choose')} className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm rounded-xl transition-colors">
                Back
              </button>
              <button
                onClick={testConnection}
                disabled={testing || !remoteUrl.startsWith('http')}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors"
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
            </div>
          </div>
        )}

        {/* ── REMOTE CONFIRM ─────────────────────────────────────────── */}
        {step === 'remote-confirm' && (
          <div className="space-y-5">
            <div>
              <h2 className="text-lg font-semibold mb-1">Connection confirmed</h2>
              <p className="text-xs text-gray-400">Ready to connect to the server below.</p>
            </div>

            <div className="p-4 bg-gray-900 border border-gray-800 rounded-xl space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="text-sm font-medium text-gray-100">Server reachable</span>
              </div>
              <p className="text-xs font-mono text-gray-400 break-all">{remoteUrl}</p>
              {testResult?.info && (
                <p className="text-xs text-gray-500">{testResult.info}</p>
              )}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep('remote-url')} className="px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-sm rounded-xl transition-colors">
                Back
              </button>
              <button
                onClick={completeRemote}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                Connect
              </button>
            </div>
          </div>
        )}

      </div>
    </div>
  )
}
