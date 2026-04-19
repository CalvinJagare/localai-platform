import { useState, useRef, useEffect } from 'react'

const API = 'http://localhost:8000'

type JobStatus =
  | 'queued'
  | 'training'
  | 'complete'
  | 'failed'
  | 'merging'
  | 'merged'
  | 'merge_failed'

interface UploadResult {
  job_id: string
  filename: string
  size_bytes: number
  status: JobStatus
}

interface StatusResult {
  status: JobStatus
  progress: number
  error: string | null
  ollama_model?: string
}

interface JobRecord {
  job_id: string
  filename?: string
  status: JobStatus
  progress: number
  error: string | null
  created_at?: string
  ollama_model?: string
  model_name?: string
}

// Statuses where nothing is changing server-side — no need to poll
const TERMINAL: JobStatus[] = ['complete', 'failed', 'merged', 'merge_failed']

export default function TrainingPage() {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [job, setJob] = useState<UploadResult | null>(null)
  const [jobStatus, setJobStatus] = useState<StatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [jobHistory, setJobHistory] = useState<JobRecord[]>([])
  const [modelName, setModelName] = useState('nexus')
  const inputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  async function fetchHistory() {
    try {
      const resp = await fetch(`${API}/jobs`)
      if (!resp.ok) return
      setJobHistory(await resp.json())
    } catch {}
  }

  // Load job history on mount
  useEffect(() => { fetchHistory() }, [])

  // Restart / stop polling whenever the status changes.
  // 'complete' stops polling but triggerMerge() transitions to 'merging',
  // which causes this effect to re-run and restart polling automatically.
  useEffect(() => {
    if (!job) return
    if (TERMINAL.includes(jobStatus?.status ?? ('' as JobStatus))) return

    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${API}/train/${job.job_id}/status`)
        if (!resp.ok) return
        const data: StatusResult = await resp.json()
        setJobStatus(data)
        if (TERMINAL.includes(data.status)) clearInterval(pollRef.current!)
      } catch {
        // network hiccup — keep polling
      }
    }, 3000)

    return () => clearInterval(pollRef.current!)
  }, [job, jobStatus?.status])

  async function uploadFile(file: File) {
    if (!file.name.endsWith('.jsonl')) {
      setError('Only .jsonl files are supported.')
      return
    }
    setError(null)
    setJob(null)
    setJobStatus(null)
    setUploading(true)

    try {
      const form = new FormData()
      form.append('file', file)
      form.append('model_name', modelName.trim() || 'nexus')
      const resp = await fetch(`${API}/train`, { method: 'POST', body: form })
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.detail ?? resp.statusText)
      }
      const result: UploadResult = await resp.json()
      setJob(result)
      setJobStatus({ status: result.status, progress: 0, error: null })
      fetchHistory()
    } catch (err) {
      setError(String(err))
    } finally {
      setUploading(false)
    }
  }

  async function triggerMerge() {
    if (!job) return
    try {
      const resp = await fetch(`${API}/train/${job.job_id}/merge`, { method: 'POST' })
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.detail ?? resp.statusText)
      }
      // Optimistic update — transitions status to 'merging' which restarts polling
      setJobStatus(prev => prev ? { ...prev, status: 'merging', error: null } : null)
      fetchHistory()
    } catch (err) {
      setError(`Could not start merge: ${String(err)}`)
    }
  }

  async function deleteJob(jobId: string) {
    if (!window.confirm('Delete this job and its model files?')) return
    try {
      const resp = await fetch(`${API}/train/${jobId}`, { method: 'DELETE' })
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.detail ?? resp.statusText)
      }
      setJobHistory(prev => prev.filter(j => j.job_id !== jobId))
    } catch (err) {
      setError(`Delete failed: ${String(err)}`)
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) uploadFile(file)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) uploadFile(file)
  }

  const isActive =
    jobStatus && ['queued', 'training', 'merging'].includes(jobStatus.status)

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Training Data Upload</h2>
      <p className="text-sm text-gray-400 mb-8">
        Upload a <code className="bg-gray-800 px-1 rounded text-gray-200">.jsonl</code> file to
        start a QLoRA fine-tuning job on{' '}
        <span className="text-gray-300">Phi-3-mini-4k-instruct</span>.
      </p>

      {/* Model name */}
      <div className="mb-4">
        <label className="block text-sm text-gray-400 mb-1.5">Model name</label>
        <input
          type="text"
          value={modelName}
          onChange={(e) => setModelName(e.target.value)}
          disabled={!!isActive}
          placeholder="nexus"
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        />
      </div>

      {/* Drop zone — disabled while training or merging */}
      <div
        onDragOver={(e) => { e.preventDefault(); if (!isActive) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (!isActive) onDrop(e) }}
        onClick={() => { if (!isActive) inputRef.current?.click() }}
        className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors
          ${isActive
            ? 'border-gray-700 bg-gray-900 opacity-50 cursor-not-allowed'
            : dragging
              ? 'border-indigo-500 bg-indigo-950 cursor-pointer'
              : 'border-gray-700 hover:border-gray-500 bg-gray-900 cursor-pointer'}`}
      >
        <input ref={inputRef} type="file" accept=".jsonl" onChange={onFileChange} className="hidden" />
        <div className="text-4xl mb-3">📂</div>
        <p className="text-sm text-gray-300 font-medium">
          {uploading
            ? 'Uploading…'
            : isActive
              ? `${jobStatus?.status === 'merging' ? 'Merging in progress…' : 'Training in progress…'}`
              : 'Drop a .jsonl file here or click to browse'}
        </p>
        <p className="text-xs text-gray-500 mt-1">Accepted format: .jsonl</p>
      </div>

      {/* Upload / merge-start errors */}
      {error && (
        <div className="mt-4 p-4 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Job card */}
      {job && jobStatus && (
        <div className="mt-5 p-5 bg-gray-900 border border-gray-800 rounded-2xl space-y-4 text-sm">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium">
              <StatusDot status={jobStatus.status} />
              <span className="capitalize text-gray-200">
                {jobStatus.status.replace('_', ' ')}
              </span>
            </div>
            <span className="text-xs text-gray-500 font-mono">{job.job_id.slice(0, 8)}…</span>
          </div>

          {/* Training progress bar */}
          {(jobStatus.status === 'queued' || jobStatus.status === 'training') && (
            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                <span>{jobStatus.status === 'queued' ? 'Waiting to start…' : 'Training…'}</span>
                <span>{jobStatus.progress}%</span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${jobStatus.status === 'queued' ? 0 : jobStatus.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Training complete — show adapter path + merge button */}
          {jobStatus.status === 'complete' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-400">
                <span>✓</span>
                <span>
                  Adapter saved to{' '}
                  <code className="text-xs bg-gray-800 px-1 rounded">
                    data/models/{job.job_id}/
                  </code>
                </span>
              </div>
              <button
                onClick={triggerMerge}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                Merge &amp; load into Ollama
              </button>
            </div>
          )}

          {/* Merging */}
          {jobStatus.status === 'merging' && (
            <div className="flex items-center gap-3 text-blue-300">
              <Spinner />
              <span>Merging model…</span>
            </div>
          )}

          {/* Merged — success */}
          {jobStatus.status === 'merged' && (
            <div className="p-3 bg-green-950 border border-green-700 rounded-xl text-green-300 text-sm">
              🎉 Ready — open Chat and select{' '}
              <span className="font-mono font-semibold">{jobStatus.ollama_model ?? 'nexus'}</span> from the dropdown.
            </div>
          )}

          {/* Training failed */}
          {jobStatus.status === 'failed' && jobStatus.error && (
            <details open>
              <summary className="text-xs text-red-400 cursor-pointer select-none">⚠ Error (click to collapse)</summary>
              <pre className="mt-1.5 p-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-xs overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{jobStatus.error}</pre>
            </details>
          )}

          {/* Merge failed */}
          {jobStatus.status === 'merge_failed' && (
            <div className="space-y-3">
              {jobStatus.error && (
                <details open>
                  <summary className="text-xs text-red-400 cursor-pointer select-none">⚠ Error (click to collapse)</summary>
                  <pre className="mt-1.5 p-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-xs overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{jobStatus.error}</pre>
                </details>
              )}
              <button
                onClick={triggerMerge}
                className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors"
              >
                Retry merge
              </button>
            </div>
          )}

          {/* Metadata */}
          <div className="border-t border-gray-800 pt-3 space-y-1.5">
            <Row label="File" value={job.filename} />
            <Row label="Size" value={`${(job.size_bytes / 1024).toFixed(1)} KB`} />
            <Row label="Base model" value="unsloth/Phi-3-mini-4k-instruct" />
          </div>
        </div>
      )}

      {/* Job history */}
      {jobHistory.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Job History</h3>
          <div className="space-y-2">
            {jobHistory.map(j => (
              <div
                key={j.job_id}
                className="p-3 bg-gray-900 border border-gray-800 rounded-xl text-sm"
              >
                <div className="flex items-center gap-3">
                  <StatusDot status={j.status} />
                  <span className="font-mono text-xs text-gray-500">{j.job_id.slice(0, 8)}…</span>
                  <span className="flex-1 text-gray-300 truncate">
                    {j.model_name ? (
                      <span className="font-medium text-indigo-300">{j.model_name}</span>
                    ) : null}
                    {j.model_name && j.filename ? <span className="text-gray-600 mx-1">·</span> : null}
                    {j.filename ?? 'unknown'}
                  </span>
                  <span className="text-xs text-gray-500 capitalize shrink-0">{j.status.replace('_', ' ')}</span>
                  {j.created_at && (
                    <span className="text-xs text-gray-600 shrink-0">
                      {new Date(j.created_at).toLocaleString()}
                    </span>
                  )}
                  <button
                    onClick={() => deleteJob(j.job_id)}
                    title="Delete job"
                    className="text-gray-600 hover:text-red-400 transition-colors shrink-0 text-base leading-none"
                  >
                    🗑
                  </button>
                </div>
                {j.error && (
                  <details className="mt-2">
                    <summary className="text-xs text-red-400 cursor-pointer select-none">⚠ Error (click to expand)</summary>
                    <pre className="mt-1.5 p-2 bg-red-950 border border-red-900 rounded-lg text-red-300 text-xs overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{j.error}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: JobStatus }) {
  const colors: Record<JobStatus, string> = {
    queued: 'bg-yellow-500',
    training: 'bg-blue-500 animate-pulse',
    complete: 'bg-green-500',
    failed: 'bg-red-500',
    merging: 'bg-purple-500 animate-pulse',
    merged: 'bg-green-400',
    merge_failed: 'bg-red-500',
  }
  return <span className={`w-2.5 h-2.5 rounded-full inline-block ${colors[status]}`} />
}

function Spinner() {
  return (
    <svg
      className="w-4 h-4 animate-spin text-blue-400"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-200">{value}</span>
    </div>
  )
}
