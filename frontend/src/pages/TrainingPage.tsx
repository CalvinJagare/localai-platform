import { useState, useRef, useEffect } from 'react'

const API = 'http://localhost:8000'

type JobStatus = 'queued' | 'training' | 'complete' | 'failed'

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
}

export default function TrainingPage() {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [job, setJob] = useState<UploadResult | null>(null)
  const [jobStatus, setJobStatus] = useState<StatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Start polling when a job is queued/training; stop when terminal state reached
  useEffect(() => {
    if (!job) return
    if (jobStatus?.status === 'complete' || jobStatus?.status === 'failed') return

    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${API}/train/${job.job_id}/status`)
        if (!resp.ok) return
        const data: StatusResult = await resp.json()
        setJobStatus(data)
        if (data.status === 'complete' || data.status === 'failed') {
          clearInterval(pollRef.current!)
        }
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
      const resp = await fetch(`${API}/train`, { method: 'POST', body: form })
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.detail ?? resp.statusText)
      }
      const result: UploadResult = await resp.json()
      setJob(result)
      setJobStatus({ status: result.status, progress: 0, error: null })
    } catch (err) {
      setError(String(err))
    } finally {
      setUploading(false)
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

  const isActive = jobStatus && (jobStatus.status === 'queued' || jobStatus.status === 'training')

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Training Data Upload</h2>
      <p className="text-sm text-gray-400 mb-8">
        Upload a <code className="bg-gray-800 px-1 rounded text-gray-200">.jsonl</code> file to
        start a QLoRA fine-tuning job on{' '}
        <span className="text-gray-300">Phi-3-mini-4k-instruct</span>.
      </p>

      {/* Drop zone — disabled while a job is running */}
      <div
        onDragOver={(e) => { e.preventDefault(); if (!isActive) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { if (!isActive) onDrop(e) }}
        onClick={() => { if (!isActive) inputRef.current?.click() }}
        className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors
          ${isActive ? 'border-gray-700 bg-gray-900 opacity-50 cursor-not-allowed' :
            dragging ? 'border-indigo-500 bg-indigo-950 cursor-pointer' :
            'border-gray-700 hover:border-gray-500 bg-gray-900 cursor-pointer'}`}
      >
        <input ref={inputRef} type="file" accept=".jsonl" onChange={onFileChange} className="hidden" />
        <div className="text-4xl mb-3">📂</div>
        <p className="text-sm text-gray-300 font-medium">
          {uploading ? 'Uploading…' : isActive ? 'Training in progress…' : 'Drop a .jsonl file here or click to browse'}
        </p>
        <p className="text-xs text-gray-500 mt-1">Accepted format: .jsonl</p>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Job card */}
      {job && jobStatus && (
        <div className="mt-5 p-5 bg-gray-900 border border-gray-800 rounded-2xl space-y-4 text-sm">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium">
              <StatusDot status={jobStatus.status} />
              <span className="capitalize text-gray-200">{jobStatus.status}</span>
            </div>
            <span className="text-xs text-gray-500 font-mono">{job.job_id.slice(0, 8)}…</span>
          </div>

          {/* Progress bar — shown while queued or training */}
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

          {/* Complete */}
          {jobStatus.status === 'complete' && (
            <div className="flex items-center gap-2 text-green-400">
              <span>✓</span>
              <span>Adapter saved to <code className="text-xs bg-gray-800 px-1 rounded">data/models/{job.job_id}/</code></span>
            </div>
          )}

          {/* Failed */}
          {jobStatus.status === 'failed' && jobStatus.error && (
            <div className="p-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-xs font-mono whitespace-pre-wrap">
              {jobStatus.error}
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
    </div>
  )
}

function StatusDot({ status }: { status: JobStatus }) {
  const colors: Record<JobStatus, string> = {
    queued: 'bg-yellow-500',
    training: 'bg-blue-500 animate-pulse',
    complete: 'bg-green-500',
    failed: 'bg-red-500',
  }
  return <span className={`w-2.5 h-2.5 rounded-full inline-block ${colors[status]}`} />
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-200">{value}</span>
    </div>
  )
}
