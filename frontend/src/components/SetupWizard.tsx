import { useState, useEffect } from 'react'
import StarField from './StarField'
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

const LOCAL_STEPS  = ['Path', 'Storage', 'Model', 'Download', 'Complete']
const REMOTE_STEPS = ['Path', 'Server', 'Confirm']

function stepIndex(step: Step): number {
  const local  = ['choose', 'storage', 'model-select', 'download', 'local-done']
  const remote = ['choose', 'remote-url', 'remote-confirm']
  const ri = remote.indexOf(step)
  return ri >= 0 ? ri : local.indexOf(step)
}

function dlStatusFromPct(pct: number): string {
  if (pct < 5)  return 'Connecting to model registry...'
  if (pct < 15) return 'Fetching model index...'
  if (pct < 80) return 'Downloading model weights...'
  if (pct < 95) return 'Verifying integrity...'
  return 'Finalising installation...'
}

// ── Astronaut SVG with pose variants ──────────────────────────────
function AstSvg({ pose = 'idle', size = 80 }: { pose?: 'idle' | 'pointing' | 'excited' | 'thumbsup'; size?: number }) {
  const animClass = pose === 'excited' ? 'ast-bounce' : pose === 'pointing' ? 'ast-lean' : 'ast-float'
  const h = Math.round(size * 1.4)

  return (
    <svg
      className={animClass}
      width={size} height={h}
      viewBox="0 0 100 140"
      xmlns="http://www.w3.org/2000/svg"
      style={{ filter: 'drop-shadow(0 0 14px rgba(99,102,241,.3))' }}
    >
      <ellipse cx="50" cy="36" rx="24" ry="26" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
      <ellipse cx="50" cy="38" rx="15" ry="13" fill="rgba(99,102,241,0.07)" stroke="#a5b4fc" strokeWidth="1" opacity=".8"/>
      <ellipse cx="44" cy="33" rx="5" ry="3.5" fill="rgba(165,180,252,0.18)"/>
      <rect x="26" y="58" width="48" height="44" rx="10" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
      <rect x="34" y="65" width="32" height="18" rx="4" fill="rgba(99,102,241,0.08)" stroke="#6366f1" strokeWidth="0.8" opacity=".6"/>
      <rect x="37" y="68" width="6" height="5" rx="1.5" fill="#34d399" opacity=".6"/>
      <rect x="45" y="68" width="5" height="5" rx="1.5" fill="#818cf8" opacity=".5"/>
      <rect x="52" y="68" width="5" height="5" rx="1.5" fill="#fbbf24" opacity=".45"/>
      <rect x="42" y="58" width="16" height="5" rx="2.5" fill="#141d35" stroke="#6366f1" strokeWidth="1"/>
      <rect x="10" y="58" width="18" height="32" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
      <ellipse cx="19" cy="92" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
      {pose === 'thumbsup' ? (
        <>
          <rect x="72" y="42" width="18" height="22" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <rect x="77" y="60" width="8" height="22" rx="4" fill="#141d35" stroke="#6366f1" strokeWidth="1"/>
          <circle cx="81" cy="60" r="5" fill="#818cf8" opacity=".7"/>
          <ellipse cx="81" cy="88" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
        </>
      ) : pose === 'pointing' ? (
        <>
          <rect x="72" y="52" width="18" height="28" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5" transform="rotate(-30 81 66)"/>
          <ellipse cx="88" cy="50" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1" transform="rotate(-30 88 50)"/>
        </>
      ) : (
        <>
          <rect x="72" y="58" width="18" height="32" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <ellipse cx="81" cy="92" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
        </>
      )}
      <rect x="30" y="100" width="16" height="28" rx="7" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
      <rect x="54" y="100" width="16" height="28" rx="7" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
      <ellipse cx="38" cy="128" rx="12" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
      <ellipse cx="62" cy="128" rx="12" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
      <line x1="50" y1="10" x2="50" y2="2" stroke="#a5b4fc" strokeWidth="1.5"/>
      <circle cx="50" cy="2" r="2.5" fill="#818cf8" opacity=".9"/>
    </svg>
  )
}

// ── Progress dots with connecting lines ───────────────────────────
function ProgDots({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div className="flex items-center justify-center pt-6 px-8 flex-shrink-0">
      {labels.map((label, i) => {
        const isDone   = i < current
        const isActive = i === current
        return (
          <div key={i} className="flex items-center">
            <div className={`flex items-center gap-1.5 text-[11px] font-mono transition-colors duration-200 ${
              isActive ? 'text-indigo-300' : isDone ? 'text-emerald-400' : 'text-gray-600'
            }`}>
              <div
                className={`w-7 h-7 rounded-full border flex items-center justify-center text-[11px] font-semibold flex-shrink-0 transition-all duration-300 ${
                  isActive
                    ? 'border-indigo-500 bg-indigo-500 text-white'
                    : isDone
                      ? 'border-emerald-400 bg-emerald-400 text-gray-950'
                      : 'border-gray-700 bg-gray-800 text-gray-600'
                }`}
                style={isActive ? { boxShadow: '0 0 14px rgba(99,102,241,.45)' } : undefined}
              >
                {isDone ? (
                  <svg viewBox="0 0 12 12" width="10" height="10">
                    <polyline points="1.5,6 4.5,9.5 10.5,2.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  </svg>
                ) : i + 1}
              </div>
              <span>{label}</span>
            </div>
            {i < labels.length - 1 && (
              <div className="relative w-12 h-px mx-2 flex-shrink-0 overflow-hidden" style={{ background: '#1a2340' }}>
                <div
                  className="absolute inset-0 origin-left transition-transform duration-500"
                  style={{
                    background: '#6366f1',
                    transform: isDone ? 'scaleX(1)' : 'scaleX(0)',
                    transitionTimingFunction: 'cubic-bezier(.4,0,.2,1)',
                  }}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ── Field helpers ─────────────────────────────────────────────────
function WzLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] tracking-[2px] uppercase font-mono mb-1.5" style={{ color: '#4a5580' }}>
      {children}
    </div>
  )
}

function WzInput({ value, onChange, placeholder, type = 'text', onKeyDown }: {
  value: string; onChange: (v: string) => void; placeholder?: string; type?: string; onKeyDown?: (e: React.KeyboardEvent) => void
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      onKeyDown={onKeyDown}
      className="flex-1 bg-gray-800 border font-mono text-sm text-gray-100 placeholder-gray-600 outline-none px-3.5 py-2.5 rounded-sm transition-colors"
      style={{ borderColor: '#1a2340' }}
      onFocus={e => (e.currentTarget.style.borderColor = 'rgba(99,102,241,.5)')}
      onBlur={e  => (e.currentTarget.style.borderColor = '#1a2340')}
    />
  )
}

// ── Main component ─────────────────────────────────────────────────
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
  const [remoteUrl,  setRemoteUrl]  = useState('http://')
  const [testing,    setTesting]    = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; info: string } | null>(null)

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
            .then(r => r.json()).then(setDiskInfo)
        })
        .catch(() => {})
    }
    if (step === 'model-select') {
      fetch(`${API}/setup/models`).then(r => r.json()).then(setModels).catch(() => {})
      fetch(`${API}/health`).then(r => r.json()).then(h => {
        const match = String(h.gpu ?? '').match(/,\s*(\d+),/)
        if (match) setGpuVram(Math.round(parseInt(match[1]) / 1024))
      }).catch(() => {})
    }
  }, [step])

  async function savePathsAndContinue() {
    setPathsSaving(true)
    try {
      const data: Record<string, string> = {}
      if (dataRoot)   data.DATA_ROOT         = dataRoot
      if (hfCache)    data.HF_CACHE_PATH      = hfCache
      if (ollamaPath) data.OLLAMA_MODELS_PATH = ollamaPath
      if (llamaCpp)   data.LLAMA_CPP_PATH     = llamaCpp

      if (Object.keys(data).length > 0) {
        await fetch(`${API}/settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data }),
        })
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

  // Selected model info for download step
  const selModel = models.find(m => m.key === selectedModel)

  return (
    <div className="fixed inset-0 bg-gray-950">
      <StarField />
      <div
        className="fixed inset-0 z-10 flex items-center justify-center"
        style={{ padding: '24px' }}
      >
        {/* Card */}
        <div
          className="relative flex flex-col overflow-hidden w-full"
          style={{
            maxWidth: '860px',
            height: 'calc(100vh - 48px)',
            maxHeight: '720px',
            background: '#0f1628',
            border: '1px solid #1a2340',
          }}
        >
          {/* Top glow line */}
          <div
            className="absolute top-0 left-0 right-0 h-px z-10"
            style={{ background: 'linear-gradient(90deg,transparent,#6366f1,transparent)', opacity: .6 }}
          />

          {/* Progress */}
          <ProgDots labels={labels} current={idx} />

          {/* Step body */}
          <div
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden"
            style={{ padding: '28px 40px 0', scrollBehavior: 'smooth' }}
          >
            <div
              key={step}
              style={{ animation: 'wzScreenIn .28s ease both' }}
            >

              {/* ── CHOOSE ─────────────────────────────────────── */}
              {step === 'choose' && (
                <div>
                  <div className="text-center mb-7">
                    <div className="text-[28px] font-bold tracking-tight mb-1">
                      sk<span style={{ color: '#818cf8' }}>AI</span>ler
                    </div>
                    <div className="text-[12px] tracking-[3px] uppercase font-mono" style={{ color: '#4a5580' }}>
                      Your AI. Your data. Your sky.
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 mb-6">
                    {[
                      {
                        key: 'new',
                        icon: (
                          <svg viewBox="0 0 48 56" width="44" xmlns="http://www.w3.org/2000/svg">
                            <path d="M24 4L30 20H18L24 4Z" fill="#6366f1"/>
                            <rect x="16" y="18" width="16" height="22" rx="3" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
                            <circle cx="24" cy="28" r="5" fill="rgba(99,102,241,0.15)" stroke="#a5b4fc" strokeWidth="1"/>
                            <path d="M16 36L8 48H18V36Z" fill="#1a2442" stroke="#6366f1" strokeWidth="1"/>
                            <path d="M32 36L40 48H30V36Z" fill="#1a2442" stroke="#6366f1" strokeWidth="1"/>
                            <path d="M20 40L24 52L28 40Z" fill="#fbbf24" opacity=".8"/>
                          </svg>
                        ),
                        title: 'New Installation',
                        desc: 'Set up skAIler on this machine for the first time. Download a model and start training locally.',
                        onClick: () => setStep('storage'),
                      },
                      {
                        key: 'connect',
                        icon: (
                          <svg viewBox="0 0 48 48" width="40" xmlns="http://www.w3.org/2000/svg">
                            <circle cx="24" cy="36" r="4" fill="#818cf8"/>
                            <path d="M14 28 Q24 18 34 28" fill="none" stroke="#818cf8" strokeWidth="2" strokeLinecap="round"/>
                            <path d="M8 22 Q24 8 40 22" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" opacity=".7"/>
                            <path d="M2 16 Q24 -2 46 16" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" opacity=".35"/>
                          </svg>
                        ),
                        title: 'Connect to Server',
                        desc: 'Join an existing skAIler installation on your network. No download needed.',
                        onClick: () => setStep('remote-url'),
                      },
                    ].map(({ key, icon, title, desc, onClick }) => (
                      <button
                        key={key}
                        onClick={onClick}
                        className="text-left cursor-pointer transition-all duration-200 p-7"
                        style={{
                          background: '#141d35',
                          border: '1.5px solid #1a2340',
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.borderColor = 'rgba(99,102,241,.5)'
                          e.currentTarget.style.background = 'rgba(99,102,241,.05)'
                          e.currentTarget.style.boxShadow = '0 0 28px rgba(99,102,241,.08)'
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.borderColor = '#1a2340'
                          e.currentTarget.style.background = '#141d35'
                          e.currentTarget.style.boxShadow = 'none'
                        }}
                      >
                        <div className="flex justify-center mb-3.5">{icon}</div>
                        <div className="text-base font-semibold mb-1.5">{title}</div>
                        <div className="text-xs leading-relaxed" style={{ color: '#4a5580' }}>{desc}</div>
                      </button>
                    ))}
                  </div>

                  <div className="flex justify-center">
                    <AstSvg pose="idle" size={80} />
                  </div>
                </div>
              )}

              {/* ── STORAGE ────────────────────────────────────── */}
              {step === 'storage' && (
                <div className="flex gap-8 items-start">
                  <div className="flex-1">
                    <div className="text-[22px] font-bold tracking-tight mb-1.5">
                      Where should skAIler <span style={{ color: '#818cf8' }}>store your data?</span>
                    </div>
                    <div className="text-[13px] leading-relaxed mb-6" style={{ color: '#4a5580' }}>
                      Choose a location with enough disk space. Models alone can take 5–20 GB each.
                    </div>

                    {([
                      { label: 'Data directory',      val: dataRoot,   set: setDataRoot,   ph: '/app/data' },
                      { label: 'HuggingFace cache',   val: hfCache,    set: setHfCache,    ph: '/mnt/d/hf-cache' },
                      { label: 'Ollama models',        val: ollamaPath, set: setOllamaPath, ph: '/mnt/d/ollama-models' },
                      { label: 'llama.cpp directory', val: llamaCpp,   set: setLlamaCpp,   ph: '/mnt/d/llama.cpp' },
                    ] as const).map(({ label, val, set, ph }) => (
                      <div key={label} className="mb-4">
                        <WzLabel>{label}</WzLabel>
                        <WzInput value={val} onChange={set as (v: string) => void} placeholder={ph} />
                      </div>
                    ))}

                    {/* Disk info */}
                    <div
                      className="rounded-sm mb-4 overflow-hidden"
                      style={{ background: '#141d35', border: '1px solid #1a2340' }}
                    >
                      <div className="flex items-center gap-3 px-4 py-2.5 text-[12px]">
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#6366f1' }} />
                        <span>Training data &amp; JSONL files</span>
                      </div>
                      <div className="flex items-center gap-3 px-4 py-2.5 text-[12px]" style={{ borderTop: '1px solid #1a2340' }}>
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#6366f1' }} />
                        <span>Trained AI models <span style={{ color: '#4a5580' }}>(5–20 GB per model)</span></span>
                      </div>
                    </div>

                    {diskInfo && (
                      <div className="flex items-center gap-2 font-mono text-[12px]">
                        <span className="w-2 h-2 rounded-full" style={{ background: '#34d399', boxShadow: '0 0 6px #34d399' }} />
                        <span style={{ color: '#34d399' }}>{diskInfo.free_gb} GB available</span>
                        {diskInfo.free_gb < 20 && (
                          <span className="ml-2" style={{ color: '#fbbf24' }}>⚠ Low disk space</span>
                        )}
                      </div>
                    )}
                  </div>

                  <div className="pt-10 flex flex-col items-center gap-1.5">
                    <AstSvg pose="idle" size={80} />
                    <div className="text-[10px] font-mono text-center" style={{ color: '#4a5580' }}>holding your data</div>
                  </div>
                </div>
              )}

              {/* ── MODEL SELECT ───────────────────────────────── */}
              {step === 'model-select' && (
                <div className="flex gap-7 items-start">
                  <div className="flex-1">
                    <div className="text-[22px] font-bold tracking-tight mb-1.5">
                      Choose your <span style={{ color: '#818cf8' }}>AI foundation</span>
                    </div>
                    <div className="text-[13px] leading-relaxed mb-6" style={{ color: '#4a5580' }}>
                      skAIler fine-tunes on top of these base models. You can add more models later.
                      {gpuVram !== null && (
                        <> &nbsp;Detected VRAM: <span className="font-mono" style={{ color: '#e2e8f8' }}>{gpuVram} GB</span></>
                      )}
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      {(models.length > 0 ? models : [
                        { key: 'phi3-mini', id: 'phi3-mini', name: 'Phi-3 Mini 3.8B', vram_gb: 4,  size_gb: 2.3 },
                        { key: 'llama32',   id: 'llama32',   name: 'Llama 3.2 3B',    vram_gb: 4,  size_gb: 1.9 },
                        { key: 'mistral7b', id: 'mistral7b', name: 'Mistral 7B',       vram_gb: 8,  size_gb: 4.1 },
                        { key: 'llama31',   id: 'llama31',   name: 'Llama 3.1 8B',     vram_gb: 8,  size_gb: 4.7 },
                      ]).map(m => {
                        const fits        = gpuVram === null || m.vram_gb <= gpuVram
                        const selected    = selectedModel === m.key
                        const eligible    = models.length > 0 ? models.filter(x => gpuVram === null || x.vram_gb <= gpuVram) : []
                        const recommended = fits && gpuVram !== null && eligible.length > 0 &&
                          m.vram_gb === Math.max(...eligible.map(x => x.vram_gb))

                        return (
                          <button
                            key={m.key}
                            onClick={() => fits && setSelectedModel(m.key)}
                            disabled={!fits}
                            className="text-left p-4 relative transition-all duration-200"
                            style={{
                              background: '#141d35',
                              border: `1.5px solid ${selected ? '#6366f1' : '#1a2340'}`,
                              boxShadow: selected ? '0 0 24px rgba(99,102,241,.14)' : 'none',
                              opacity: fits ? 1 : 0.4,
                              cursor: fits ? 'pointer' : 'not-allowed',
                            }}
                            onMouseEnter={e => fits && !selected && (e.currentTarget.style.borderColor = 'rgba(99,102,241,.4)')}
                            onMouseLeave={e => fits && !selected && (e.currentTarget.style.borderColor = '#1a2340')}
                          >
                            {selected && (
                              <span
                                className="absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full"
                                style={{ background: '#6366f1', boxShadow: '0 0 6px #6366f1' }}
                              />
                            )}
                            <div className="mb-2">
                              <span
                                className="text-[9px] font-mono tracking-[1px] px-1.5 py-0.5 rounded-sm inline-block"
                                style={
                                  recommended
                                    ? { background: 'rgba(99,102,241,.2)', color: '#a5b4fc' }
                                    : fits
                                      ? { background: 'rgba(52,211,153,.12)', color: '#34d399' }
                                      : { background: 'rgba(74,85,128,.2)', color: '#4a5580' }
                                }
                              >
                                {recommended ? 'Recommended' : fits ? 'Compatible' : `Needs ${m.vram_gb} GB VRAM`}
                              </span>
                            </div>
                            <div className="text-sm font-semibold mb-1">{m.name}</div>
                            <div className="flex gap-3.5 text-[10px] font-mono mt-2">
                              <span><span style={{ color: '#4a5580' }}>Size </span><span style={{ color: '#a5b4fc' }}>{m.size_gb} GB</span></span>
                              <span><span style={{ color: '#4a5580' }}>VRAM </span><span style={{ color: '#a5b4fc' }}>{m.vram_gb} GB</span></span>
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  </div>

                  <div className="pt-9 flex flex-col items-center gap-2">
                    <AstSvg pose="pointing" size={80} />
                    <div className="text-[10px] font-mono text-center" style={{ color: '#4a5580' }}>Phi-3 recommended</div>
                  </div>
                </div>
              )}

              {/* ── DOWNLOAD ───────────────────────────────────── */}
              {step === 'download' && (
                <div className="flex gap-8 items-center">
                  <div className="flex-1">
                    <div className="text-[22px] font-bold tracking-tight mb-1.5">
                      Downloading your <span style={{ color: '#818cf8' }}>AI model</span>
                    </div>
                    <div className="text-[13px] mb-6" style={{ color: '#4a5580' }}>
                      {selModel ? `${selModel.name} · ${selModel.size_gb} GB total` : 'Preparing download...'}
                    </div>

                    <div
                      className="font-mono font-bold mb-2"
                      style={{ fontSize: '48px', lineHeight: 1, color: '#818cf8' }}
                    >
                      {downloadPct}%
                    </div>

                    {/* Progress bar with rocket tip */}
                    <div
                      className="relative mb-3"
                      style={{ height: '8px', background: '#141d35', border: '1px solid #1a2340', borderRadius: '4px', overflow: 'visible' }}
                    >
                      <div
                        className="h-full rounded transition-all duration-300"
                        style={{
                          width: `${downloadPct}%`,
                          background: 'linear-gradient(90deg,#6366f1,#818cf8)',
                          position: 'relative',
                        }}
                      >
                        {/* Rocket tip */}
                        <svg
                          viewBox="0 0 20 24" width="18" height="18"
                          style={{ position: 'absolute', right: '-6px', top: '-5px' }}
                          xmlns="http://www.w3.org/2000/svg"
                        >
                          <path d="M10 0L13 8H7L10 0Z" fill="#6366f1"/>
                          <rect x="8" y="8" width="4" height="10" rx="2" fill="#6366f1"/>
                          <path d="M6 16L10 24L14 16Z" fill="#fbbf24" opacity=".9"/>
                        </svg>
                      </div>
                    </div>

                    <div className="font-mono text-[12px] mb-5" style={{ color: '#4a5580' }}>
                      {dlStatusFromPct(downloadPct)}
                    </div>

                    {downloadError && (
                      <div
                        className="p-4 text-sm space-y-2"
                        style={{ background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.3)', borderRadius: '3px' }}
                      >
                        <p className="font-medium" style={{ color: '#f87171' }}>Download failed</p>
                        <p className="font-mono text-xs break-all" style={{ color: '#fca5a5' }}>{downloadError}</p>
                        <button
                          onClick={() => setStep('model-select')}
                          className="text-xs transition-colors"
                          style={{ color: '#f87171' }}
                          onMouseEnter={e => (e.currentTarget.style.color = '#fca5a5')}
                          onMouseLeave={e => (e.currentTarget.style.color = '#f87171')}
                        >
                          ← Back to model selection
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-col items-center gap-1.5">
                    <AstSvg pose="excited" size={80} />
                    <div className="text-[10px] font-mono text-center" style={{ color: '#4a5580' }}>Watching closely...</div>
                  </div>
                </div>
              )}

              {/* ── LOCAL DONE ─────────────────────────────────── */}
              {step === 'local-done' && (
                <div className="flex flex-col items-center text-center">
                  {/* Success ring */}
                  <div
                    className="w-[72px] h-[72px] rounded-full border-2 flex items-center justify-center mb-6"
                    style={{
                      borderColor: '#34d399',
                      animation: 'ringPulse 2.2s ease-in-out infinite',
                    }}
                  >
                    <svg width="32" height="32" viewBox="0 0 32 32">
                      <polyline
                        points="5,16 12,24 27,8"
                        fill="none"
                        stroke="#34d399"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeDasharray="40"
                        strokeDashoffset="40"
                        style={{ animation: 'wzCheckDraw .6s .2s ease forwards' }}
                      />
                    </svg>
                  </div>

                  <div className="text-[22px] font-bold tracking-tight mb-1.5">
                    sk<span style={{ color: '#818cf8' }}>AI</span>ler is <span style={{ color: '#34d399' }}>ready</span>
                  </div>
                  <div className="text-[13px] mb-6" style={{ color: '#4a5580' }}>
                    Your local AI is configured and ready to train.
                  </div>

                  <div className="grid grid-cols-3 gap-2.5 w-full max-w-[480px] mb-6">
                    {[
                      { k: 'Storage', v: dataRoot || '/app/data', mono: true },
                      { k: 'Model',   v: selModel?.name ?? selectedModel, mono: false },
                      { k: 'Status',  v: 'Ready', green: true },
                    ].map(({ k, v, mono, green }) => (
                      <div key={k} className="p-3 text-left rounded-sm" style={{ background: '#141d35', border: '1px solid #1a2340' }}>
                        <div className="text-[9px] tracking-[2px] uppercase font-mono mb-1" style={{ color: '#4a5580' }}>{k}</div>
                        <div className={`text-[12px] font-medium truncate ${mono ? 'font-mono text-[11px]' : ''}`} style={green ? { color: '#34d399' } : undefined}>
                          {v}
                        </div>
                      </div>
                    ))}
                  </div>

                  <AstSvg pose="thumbsup" size={80} />
                  <div className="text-[11px] font-mono mt-2.5" style={{ color: '#4a5580' }}>mission accomplished</div>
                </div>
              )}

              {/* ── REMOTE URL ─────────────────────────────────── */}
              {step === 'remote-url' && (
                <div className="flex gap-8 items-start">
                  <div className="flex-1">
                    <div className="text-[22px] font-bold tracking-tight mb-1.5">
                      Connect to a <span style={{ color: '#818cf8' }}>skAIler server</span>
                    </div>
                    <div className="text-[13px] leading-relaxed mb-6" style={{ color: '#4a5580' }}>
                      Enter the address of an existing skAIler installation on your network or the internet.
                    </div>

                    <div className="mb-4">
                      <WzLabel>Server URL</WzLabel>
                      <div className="flex gap-2">
                        <WzInput
                          value={remoteUrl}
                          onChange={v => { setRemoteUrl(v); setTestResult(null) }}
                          placeholder="https://skailer.yourcompany.com"
                          onKeyDown={e => e.key === 'Enter' && testConnection()}
                        />
                        <button
                          onClick={testConnection}
                          disabled={testing || !remoteUrl.startsWith('http')}
                          className="px-4 text-[12px] font-medium whitespace-nowrap transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed rounded-sm"
                          style={{ background: '#1a2442', border: '1px solid #1a2340', color: '#a5b4fc' }}
                          onMouseEnter={e => { e.currentTarget.style.borderColor = '#6366f1'; e.currentTarget.style.color = '#818cf8' }}
                          onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2340'; e.currentTarget.style.color = '#a5b4fc' }}
                        >
                          {testing ? 'Testing...' : 'Test'}
                        </button>
                      </div>
                    </div>

                    {testResult && !testResult.ok && (
                      <div
                        className="p-3 text-sm"
                        style={{ background: 'rgba(248,113,113,.06)', border: '1px solid rgba(248,113,113,.3)', borderRadius: '3px' }}
                      >
                        <span style={{ color: '#f87171' }}>Could not connect: </span>
                        <span className="font-mono text-xs" style={{ color: '#fca5a5' }}>{testResult.info}</span>
                      </div>
                    )}
                  </div>

                  <div className="pt-10">
                    <AstSvg pose="idle" size={80} />
                  </div>
                </div>
              )}

              {/* ── REMOTE CONFIRM ─────────────────────────────── */}
              {step === 'remote-confirm' && (
                <div className="flex gap-8 items-center">
                  <div className="flex-1">
                    <div className="text-[22px] font-bold tracking-tight mb-1.5">
                      Connection <span style={{ color: '#818cf8' }}>confirmed</span>
                    </div>
                    <div className="text-[13px] mb-6" style={{ color: '#4a5580' }}>
                      Successfully reached the skAIler server. Ready to connect.
                    </div>

                    <div
                      className="rounded-sm overflow-hidden mb-4"
                      style={{ background: '#141d35', border: '1px solid #34d399' }}
                    >
                      <div className="flex justify-between px-5 py-2.5 text-[12px]">
                        <span style={{ color: '#4a5580' }}>Server</span>
                        <span className="font-mono truncate max-w-xs">{remoteUrl}</span>
                      </div>
                      {testResult?.info && (
                        <div className="flex justify-between px-5 py-2.5 text-[12px]" style={{ borderTop: '1px solid #1a2340' }}>
                          <span style={{ color: '#4a5580' }}>Info</span>
                          <span style={{ color: '#e2e8f8' }}>{testResult.info}</span>
                        </div>
                      )}
                      <div className="flex justify-between px-5 py-2.5 text-[12px]" style={{ borderTop: '1px solid #1a2340' }}>
                        <span style={{ color: '#4a5580' }}>Status</span>
                        <span style={{ color: '#34d399' }}>Reachable</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-center gap-1.5">
                    <AstSvg pose="thumbsup" size={80} />
                    <div className="text-[10px] font-mono text-center" style={{ color: '#4a5580' }}>ready to launch</div>
                  </div>
                </div>
              )}

            </div>
          </div>

          {/* Footer */}
          <div
            className="flex items-center justify-between flex-shrink-0"
            style={{ padding: '20px 40px 24px' }}
          >
            {/* Back */}
            <div>
              {step !== 'choose' && step !== 'download' && (
                <button
                  onClick={() => {
                    if (step === 'storage')        setStep('choose')
                    else if (step === 'model-select') setStep('storage')
                    else if (step === 'local-done')   setStep('model-select')
                    else if (step === 'remote-url')   setStep('choose')
                    else if (step === 'remote-confirm') setStep('remote-url')
                  }}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150"
                  style={{ background: 'transparent', border: '1px solid #1a2340', color: '#4a5580' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#a5b4fc'; e.currentTarget.style.color = '#e2e8f8' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2340'; e.currentTarget.style.color = '#4a5580' }}
                >
                  Back
                </button>
              )}
            </div>

            {/* Right: skip + CTA */}
            <div className="flex gap-2.5">
              {step !== 'local-done' && step !== 'remote-confirm' && (
                <button
                  onClick={onComplete}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150"
                  style={{ background: 'transparent', border: '1px solid #1a2340', color: '#4a5580' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#a5b4fc'; e.currentTarget.style.color = '#e2e8f8' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2340'; e.currentTarget.style.color = '#4a5580' }}
                >
                  Skip setup
                </button>
              )}

              {/* Primary CTA */}
              {step === 'choose' && (
                <button
                  disabled
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm opacity-35 cursor-not-allowed"
                  style={{ background: '#6366f1', color: '#fff' }}
                >
                  Continue
                </button>
              )}
              {step === 'storage' && (
                <button
                  onClick={savePathsAndContinue}
                  disabled={pathsSaving}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: '#6366f1', color: '#fff' }}
                  onMouseEnter={e => !pathsSaving && (e.currentTarget.style.background = '#818cf8')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#6366f1')}
                >
                  {pathsSaving ? 'Applying...' : 'Continue'}
                </button>
              )}
              {step === 'model-select' && (
                <button
                  onClick={startDownload}
                  disabled={!selectedModel}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: '#6366f1', color: '#fff' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#818cf8')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#6366f1')}
                >
                  Download &amp; Install
                </button>
              )}
              {step === 'download' && (
                <button
                  onClick={() => setStep('model-select')}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150"
                  style={{ background: 'transparent', border: '1px solid #1a2340', color: '#4a5580' }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#a5b4fc'; e.currentTarget.style.color = '#e2e8f8' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#1a2340'; e.currentTarget.style.color = '#4a5580' }}
                >
                  Cancel
                </button>
              )}
              {step === 'local-done' && (
                <button
                  onClick={completeLocal}
                  className="text-[14px] font-semibold px-8 py-3 rounded-sm transition-opacity"
                  style={{ background: '#34d399', color: '#0a0f1e' }}
                  onMouseEnter={e => (e.currentTarget.style.opacity = '.9')}
                  onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                >
                  Launch skAIler
                </button>
              )}
              {step === 'remote-url' && (
                <button
                  onClick={testConnection}
                  disabled={testing || !remoteUrl.startsWith('http')}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: '#6366f1', color: '#fff' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#818cf8')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#6366f1')}
                >
                  {testing ? 'Testing...' : 'Verify'}
                </button>
              )}
              {step === 'remote-confirm' && (
                <button
                  onClick={completeRemote}
                  className="text-[12px] font-semibold px-5 py-2 rounded-sm transition-all duration-150"
                  style={{ background: '#6366f1', color: '#fff' }}
                  onMouseEnter={e => (e.currentTarget.style.background = '#818cf8')}
                  onMouseLeave={e => (e.currentTarget.style.background = '#6366f1')}
                >
                  Connect
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Keyframes injected once */}
      <style>{`
        @keyframes wzScreenIn { from { opacity:0; transform:translateX(14px); } to { opacity:1; transform:none; } }
        @keyframes wzCheckDraw { to { stroke-dashoffset:0; } }
      `}</style>
    </div>
  )
}
