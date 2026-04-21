import { useState, useRef, useEffect } from 'react'
import { API } from '../lib/server'
import type { Profile } from '../App'
import { useToast } from '../components/Toast'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type JobStatus =
  | 'queued' | 'training' | 'complete' | 'failed'
  | 'merging' | 'merged' | 'merge_failed' | 'cancelled'

type DataFormat = 'chat' | 'instruction' | 'text' | 'mixed' | 'unknown'

interface ValidationResult {
  valid: number
  invalid: number
  total: number
  format: DataFormat
  errors: Array<{ line: number; reason: string }>
}

interface SelectedFile {
  id: string
  file: File
  validation: ValidationResult | null
}

interface UploadResult {
  job_id: string
  filename: string
  size_bytes?: number
  status: JobStatus
  base_model_override?: string | null
}

interface StatusResult {
  status: JobStatus
  progress: number
  error: string | null
  ollama_model?: string
  merge_step?: string
  loss_history?: number[]
}

interface JobRecord {
  job_id: string
  filename?: string
  data_file?: string
  status: JobStatus
  progress: number
  error: string | null
  created_at?: string
  ollama_model?: string
  profile_id?: string
  epochs?: number
}

interface DataFile {
  filename: string
  display_name: string
  size_bytes: number
  line_count: number
}

interface QueueItem {
  id: string
  filename: string      // stored filename (full, e.g. uuid_dolly.jsonl)
  displayName: string
  epochs: number
}

const TERMINAL: JobStatus[] = ['complete', 'failed', 'merged', 'merge_failed', 'cancelled']

const FORMAT_LABEL: Record<DataFormat, string> = {
  chat: 'chat', instruction: 'instruction', text: 'text', mixed: 'mixed', unknown: 'unknown',
}

const EPOCH_OPTIONS = [1, 2, 3, 5, 10]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomId() { return Math.random().toString(36).slice(2) }

async function validateJsonl(file: File): Promise<ValidationResult> {
  const lines = (await file.text()).split('\n').filter(l => l.trim())
  let valid = 0, invalid = 0
  const errors: ValidationResult['errors'] = []
  const formats = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    try {
      const rec = JSON.parse(lines[i])
      if (rec && typeof rec === 'object') {
        if ('messages' in rec)        formats.add('chat')
        else if ('instruction' in rec) formats.add('instruction')
        else if ('text' in rec)        formats.add('text')
        else formats.add('unknown')
      }
      valid++
    } catch {
      invalid++
      if (errors.length < 5) errors.push({ line: i + 1, reason: 'Invalid JSON' })
    }
  }

  const fs = [...formats]
  const format: DataFormat =
    fs.length === 0 ? 'unknown'
    : fs.length === 1 ? (fs[0] as DataFormat)
    : 'mixed'

  return { valid, invalid, total: lines.length, format, errors }
}

async function combineFiles(items: SelectedFile[]): Promise<File> {
  const parts: string[] = []
  for (const { file } of items) {
    const lines = (await file.text()).split('\n').filter(l => l.trim())
    for (const line of lines) {
      try { JSON.parse(line); parts.push(line) } catch { /* skip */ }
    }
  }
  const name = items.length === 1
    ? items[0].file.name
    : `combined_${items.length}files.jsonl`
  return new File([parts.join('\n') + '\n'], name, { type: 'application/json' })
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  profile: Profile | null
  profiles?: Profile[]
  onProfileUpdate: (p: Profile) => void
  onDataAdded?: () => void
  onTrainingStarted?: () => void
}

export default function TrainingPage({ profile, profiles = [], onProfileUpdate, onDataAdded, onTrainingStarted }: Props) {
  const [selectedFiles, setSelectedFiles]       = useState<SelectedFile[]>([])
  const [dragging, setDragging]                 = useState(false)
  const [uploading, setUploading]               = useState(false)
  const [job, setJob]                           = useState<UploadResult | null>(null)
  const [jobStatus, setJobStatus]               = useState<StatusResult | null>(null)
  const [error, setError]                       = useState<string | null>(null)
  const [jobHistory, setJobHistory]             = useState<JobRecord[]>([])
  const [continueTraining, setContinueTraining] = useState(true)
  const [epochs, setEpochs]                     = useState(3)
  const [autoMerge, setAutoMerge]               = useState(false)
  const trainStartMsRef = useRef<number | null>(null)

  // Queue state — persisted per profile
  const [queue, setQueue]             = useState<QueueItem[]>([])
  const [queueRunning, setQueueRunning] = useState(false)
  const [dataFiles, setDataFiles]     = useState<DataFile[]>([])
  const [queueOpen, setQueueOpen]     = useState(false)
  const [addingFile, setAddingFile]   = useState('')
  const [addingEpochs, setAddingEpochs] = useState(3)

  const inputRef = useRef<HTMLInputElement>(null)
  const pollRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const { addToast } = useToast()

  async function fetchHistory() {
    if (!profile) return
    try {
      const resp = await fetch(`${API}/jobs?profile_id=${profile.id}`)
      if (!resp.ok) return
      setJobHistory(await resp.json())
    } catch {}
  }

  async function fetchDataFiles() {
    try {
      const resp = await fetch(`${API}/data/files`)
      if (!resp.ok) return
      setDataFiles(await resp.json())
    } catch {}
  }

  useEffect(() => {
    setJob(null); setJobStatus(null); setError(null); setSelectedFiles([])
    setContinueTraining(true); setQueueRunning(false)
    trainStartMsRef.current = null
    fetchHistory()
    try {
      const raw = localStorage.getItem(`training_queue_${profile?.id}`)
      setQueue(raw ? JSON.parse(raw) : [])
    } catch { setQueue([]) }
  }, [profile?.id])

  useEffect(() => {
    if (!profile) return
    localStorage.setItem(`training_queue_${profile.id}`, JSON.stringify(queue))
  }, [queue, profile?.id])

  useEffect(() => {
    if (queueOpen) fetchDataFiles()
  }, [queueOpen])

  // Track training start time for ETA
  useEffect(() => {
    if (jobStatus?.status === 'training' && trainStartMsRef.current === null) {
      trainStartMsRef.current = Date.now()
    }
  }, [jobStatus?.status])

  // Auto-merge when complete
  useEffect(() => {
    if (autoMerge && jobStatus?.status === 'complete' && job) {
      triggerMerge()
    }
  }, [jobStatus?.status])

  // Toast on terminal states
  useEffect(() => {
    if (jobStatus?.status === 'complete' && !autoMerge) addToast('success', 'Training complete — ready to merge')
    if (jobStatus?.status === 'merged')                  addToast('success', `${profile?.display_name} is ready in Ollama`)
    if (jobStatus?.status === 'failed')                  addToast('error', 'Training failed')
    if (jobStatus?.status === 'merge_failed')            addToast('error', 'Merge failed')
  }, [jobStatus?.status])

  // Update profile after merge
  useEffect(() => {
    if (jobStatus?.status === 'merged' && profile) {
      fetch(`${API}/profiles`)
        .then(r => r.json())
        .then((all: Profile[]) => {
          const updated = all.find(p => p.id === profile.id)
          if (updated) onProfileUpdate(updated)
        })
        .catch(() => {})
    }
  }, [jobStatus?.status])

  // Poll active job
  useEffect(() => {
    if (!job) return
    if (TERMINAL.includes(jobStatus?.status ?? ('' as JobStatus))) return

    pollRef.current = setInterval(async () => {
      try {
        const resp = await fetch(`${API}/train/${job.job_id}/status`)
        if (!resp.ok) return
        const data: StatusResult = await resp.json()
        setJobStatus(data)
        if (TERMINAL.includes(data.status)) {
          clearInterval(pollRef.current!)
          fetchHistory()
        }
      } catch {}
    }, 3000)

    return () => clearInterval(pollRef.current!)
  }, [job, jobStatus?.status])

  // Auto-advance queue when current job reaches terminal status
  useEffect(() => {
    if (!queueRunning) return
    if (!TERMINAL.includes(jobStatus?.status ?? ('' as JobStatus))) return
    if (queue.length === 0) { setQueueRunning(false); return }

    const [next, ...rest] = queue
    setQueue(rest)
    submitFromFile(next)
  }, [jobStatus?.status, queueRunning])

  function addFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList).filter(f => f.name.endsWith('.jsonl'))
    if (incoming.length === 0) { setError('Only .jsonl files are accepted.'); return }
    setError(null)
    onDataAdded?.()
    const newItems: SelectedFile[] = incoming.map(file => ({ id: randomId(), file, validation: null }))
    setSelectedFiles(prev => {
      const existing = new Set(prev.map(i => i.file.name))
      return [...prev, ...newItems.filter(i => !existing.has(i.file.name))]
    })
    newItems.forEach(async item => {
      const result = await validateJsonl(item.file)
      setSelectedFiles(prev => prev.map(i => i.id === item.id ? { ...i, validation: result } : i))
    })
  }

  function removeFile(id: string) { setSelectedFiles(prev => prev.filter(i => i.id !== id)) }

  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false)
    if (!isActive) addFiles(e.dataTransfer.files)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) addFiles(e.target.files)
    e.target.value = ''
  }

  async function startTraining() {
    if (!profile || selectedFiles.length === 0) return
    setError(null); setJob(null); setJobStatus(null); setUploading(true)
    try {
      const combined = await combineFiles(selectedFiles)
      const form = new FormData()
      form.append('file', combined)
      form.append('profile_id', profile.id)
      form.append('epochs', String(epochs))
      form.append('start_fresh', continueTraining ? 'false' : 'true')
      const resp = await fetch(`${API}/train`, { method: 'POST', body: form })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const result: UploadResult = await resp.json()
      setJob(result)
      setJobStatus({ status: result.status, progress: 0, error: null })
      setSelectedFiles([])
      onTrainingStarted?.()
      fetchHistory()
    } catch (err) {
      setError(String(err))
    } finally {
      setUploading(false)
    }
  }

  async function submitFromFile(item: QueueItem) {
    if (!profile) return
    setError(null); setJob(null); setJobStatus(null)
    try {
      const resp = await fetch(`${API}/train/from-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: item.filename,
          profile_id: profile.id,
          epochs: item.epochs,
          start_fresh: !continueTraining,
        }),
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const result: UploadResult = await resp.json()
      setJob(result)
      setJobStatus({ status: result.status, progress: 0, error: null })
      fetchHistory()
    } catch (err) {
      setError(String(err))
      setQueueRunning(false)
    }
  }

  function runQueue() {
    if (queue.length === 0 || !profile) return
    const [first, ...rest] = queue
    setQueue(rest)
    setQueueRunning(true)
    submitFromFile(first)
  }

  function addToQueue() {
    if (!addingFile) return
    const df = dataFiles.find(f => f.filename === addingFile)
    if (!df) return
    setQueue(prev => [...prev, {
      id: randomId(),
      filename: df.filename,
      displayName: df.display_name,
      epochs: addingEpochs,
    }])
    setAddingFile('')
  }

  async function triggerMerge() {
    if (!job) return
    try {
      const resp = await fetch(`${API}/train/${job.job_id}/merge`, { method: 'POST' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
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
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      setJobHistory(prev => prev.filter(j => j.job_id !== jobId))
    } catch (err) {
      setError(`Delete failed: ${String(err)}`)
    }
  }

  async function cancelJob() {
    if (!job) return
    try {
      const resp = await fetch(`${API}/train/${job.job_id}/cancel`, { method: 'POST' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      setJobStatus(prev => prev ? { ...prev, status: 'cancelled' } : null)
      setQueueRunning(false)
      fetchHistory()
    } catch (err) {
      setError(`Cancel failed: ${String(err)}`)
    }
  }

  async function rerunJob(jobId: string) {
    if (!profile) return
    setError(null)
    try {
      const resp = await fetch(`${API}/train/${jobId}/rerun`, { method: 'POST' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const result: UploadResult = await resp.json()
      setJob(result)
      setJobStatus({ status: result.status, progress: 0, error: null })
      fetchHistory()
    } catch (err) {
      setError(`Re-run failed: ${String(err)}`)
    }
  }

  function getEtaText(): string | null {
    if (!trainStartMsRef.current || !jobStatus || jobStatus.progress < 5) return null
    const elapsedSec = (Date.now() - trainStartMsRef.current) / 1000
    const totalEstSec = elapsedSec / (jobStatus.progress / 100)
    const remainSec = totalEstSec - elapsedSec
    if (remainSec < 60) return '< 1 min left'
    return `~${Math.round(remainSec / 60)} min left`
  }

  function suggestedEpochs(validCount: number): string | null {
    if (validCount === 0) return null
    if (validCount < 200)   return `${validCount} examples is very small — consider 10 epochs`
    if (validCount < 1000)  return `${validCount} examples — 5 epochs recommended`
    if (validCount < 10000) return `${validCount} examples — 3 epochs recommended`
    return `${validCount.toLocaleString()} examples — 1–2 epochs recommended to avoid overfitting`
  }

  const isActive = jobStatus && ['queued', 'training', 'merging'].includes(jobStatus.status)
  const totalValid   = selectedFiles.reduce((n, i) => n + (i.validation?.valid ?? 0), 0)
  const allValidated = selectedFiles.length > 0 && selectedFiles.every(i => i.validation !== null)
  const anyUsable    = selectedFiles.some(i => (i.validation?.valid ?? 0) > 0)
  const canTrain     = allValidated && anyUsable && !isActive && !uploading && profile !== null

  if (!profile) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 text-sm">Select a profile from the sidebar to start training.</p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Training</h2>
      <p className="text-sm text-gray-400 mb-2">
        Upload one or more{' '}
        <code className="bg-gray-800 px-1 rounded text-gray-200">.jsonl</code> files to fine-tune{' '}
        <span className="text-gray-300">Phi-3-mini-4k-instruct</span>.
      </p>

      {/* Profile badge */}
      <div className="mb-4 flex items-center flex-wrap gap-2">
        <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm">
          <span className="text-gray-400">Training for:</span>
          <span className="font-medium text-gray-200">{profile.display_name}</span>
          {profile.current_model && (
            <span className="text-xs text-gray-500 font-mono">({profile.current_model})</span>
          )}
        </div>
        {profile.base_profile_id && (() => {
          const base = profiles.find(p => p.id === profile.base_profile_id)
          return base ? (
            <span className="text-xs text-gray-500 flex items-center gap-1">
              inherits from <span className="text-gray-400 font-medium">{base.display_name}</span>
            </span>
          ) : null
        })()}
      </div>

      {/* Continue / fresh toggle */}
      {profile.current_model && (
        <div className="mb-4 p-3 bg-gray-900 border border-gray-700 rounded-xl flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-gray-200">
              {continueTraining ? 'Continue from existing model' : 'Start fresh from Phi-3-mini'}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              {continueTraining
                ? <>Builds on <span className="font-mono text-gray-400">{profile.current_model}</span> — include previous training data to avoid forgetting</>
                : 'Resets to base model — previous fine-tuning is discarded'}
            </p>
          </div>
          <button
            onClick={() => setContinueTraining(c => !c)}
            className={`relative flex-shrink-0 w-10 h-6 rounded-full transition-colors ${continueTraining ? 'bg-indigo-600' : 'bg-gray-700'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${continueTraining ? 'translate-x-4' : 'translate-x-0'}`} />
          </button>
        </div>
      )}

      {/* Epoch selector + auto-merge */}
      <div className="mb-4 space-y-2">
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 shrink-0">Epochs</span>
          <div className="flex gap-1">
            {EPOCH_OPTIONS.map(n => (
              <button
                key={n}
                onClick={() => setEpochs(n)}
                className={`w-9 h-7 text-xs font-medium rounded-lg transition-colors ${epochs === n ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="text-xs text-gray-500">
            {epochs === 1 ? 'Fast pass' : epochs <= 3 ? 'Standard' : epochs <= 5 ? 'Thorough' : 'Deep — risk overfitting'}
          </span>
        </div>
        {allValidated && totalValid > 0 && suggestedEpochs(totalValid) && (
          <p className="text-xs text-indigo-400/70 pl-16">{suggestedEpochs(totalValid)}</p>
        )}
        <div className="flex items-center gap-2 pl-16">
          <input
            id="auto-merge"
            type="checkbox"
            checked={autoMerge}
            onChange={e => setAutoMerge(e.target.checked)}
            className="accent-indigo-500"
          />
          <label htmlFor="auto-merge" className="text-xs text-gray-400 cursor-pointer select-none">
            Auto-merge when training completes
          </label>
        </div>
      </div>

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); if (!isActive) setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => { if (!isActive) inputRef.current?.click() }}
        className={`border-2 border-dashed rounded-2xl p-8 text-center transition-colors mb-4
          ${isActive
            ? 'border-gray-700 bg-gray-900 opacity-50 cursor-not-allowed'
            : dragging
              ? 'border-indigo-500 bg-indigo-950 cursor-pointer'
              : 'border-gray-700 hover:border-gray-500 bg-gray-900 cursor-pointer'}`}
      >
        <input ref={inputRef} type="file" accept=".jsonl" multiple onChange={onFileChange} className="hidden" />
        <div className="text-3xl mb-2">📂</div>
        <p className="text-sm text-gray-300 font-medium">
          {isActive
            ? jobStatus?.status === 'merging' ? 'Merging in progress…' : 'Training in progress…'
            : selectedFiles.length > 0
              ? 'Drop more files or click to add'
              : 'Drop .jsonl files here or click to browse'}
        </p>
        <p className="text-xs text-gray-500 mt-1">
          {selectedFiles.length > 0 ? 'Multiple files will be combined' : 'One or more .jsonl files'}
        </p>
      </div>

      {/* Selected files */}
      {selectedFiles.length > 0 && (
        <div className="space-y-2 mb-4">
          {selectedFiles.map(item => (
            <FileCard key={item.id} item={item} onRemove={() => removeFile(item.id)} />
          ))}
          {allValidated && (
            <div className="flex items-center justify-between px-1 pt-1 text-xs text-gray-500">
              <span>
                Total:{' '}
                <span className="text-gray-300 font-medium">
                  {totalValid.toLocaleString()} valid example{totalValid !== 1 ? 's' : ''}
                </span>
                {selectedFiles.length > 1 && ` across ${selectedFiles.length} files`}
              </span>
              {!anyUsable && (
                <span className="text-red-400">No usable examples — fix files before training</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* Start Training button */}
      {selectedFiles.length > 0 && !isActive && (
        <button
          onClick={startTraining}
          disabled={!canTrain || uploading}
          className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-xl transition-colors mb-4"
        >
          {uploading
            ? 'Uploading…'
            : !allValidated
              ? 'Validating files…'
              : `Start Training — ${epochs} epoch${epochs !== 1 ? 's' : ''}`}
        </button>
      )}

      {error && (
        <div className="mb-4 p-4 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">{error}</div>
      )}

      {/* Active job card */}
      {job && jobStatus && (
        <div className="mt-2 p-5 bg-gray-900 border border-gray-800 rounded-2xl space-y-4 text-sm">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 font-medium">
              <StatusDot status={jobStatus.status} />
              <span className="capitalize text-gray-200">{jobStatus.status.replace('_', ' ')}</span>
              {queueRunning && queue.length > 0 && (
                <span className="text-xs text-indigo-400 font-normal">· {queue.length} more queued</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {(jobStatus.status === 'queued' || jobStatus.status === 'training') && (
                <button
                  onClick={cancelJob}
                  className="text-xs text-gray-500 hover:text-red-400 transition-colors"
                >
                  Cancel
                </button>
              )}
              <span className="text-xs text-gray-500 font-mono">{job.job_id.slice(0, 8)}…</span>
            </div>
          </div>

          {(jobStatus.status === 'queued' || jobStatus.status === 'training') && (
            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                <span>{jobStatus.status === 'queued' ? 'Waiting to start…' : 'Training…'}</span>
                <span className="flex items-center gap-2">
                  {jobStatus.status === 'training' && getEtaText() && (
                    <span className="text-gray-500">{getEtaText()}</span>
                  )}
                  <span>{jobStatus.progress}%</span>
                </span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${jobStatus.status === 'queued' ? 0 : jobStatus.progress}%` }}
                />
              </div>
              {jobStatus.loss_history && jobStatus.loss_history.length >= 2 && (
                <LossSparkline losses={jobStatus.loss_history} />
              )}
            </div>
          )}

          {jobStatus.status === 'complete' && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-green-400">
                <span>✓</span>
                <span>
                  Adapter saved — ready to merge into <span className="font-medium">{profile.display_name}</span>
                  {queueRunning && queue.length > 0 && ' (next run starting…)'}
                </span>
              </div>
              <button onClick={triggerMerge} className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors">
                Merge &amp; load into Ollama
              </button>
            </div>
          )}

          {jobStatus.status === 'merging' && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-3 text-blue-300"><Spinner /><span>Merging model…</span></div>
              {jobStatus.merge_step && (
                <p className="text-xs text-gray-500 pl-7">{jobStatus.merge_step}</p>
              )}
            </div>
          )}

          {jobStatus.status === 'merged' && (
            <div className="p-3 bg-green-950 border border-green-700 rounded-xl text-green-300 text-sm">
              🎉 <span className="font-medium">{profile.display_name}</span> is ready — switch to Chat to start talking.
            </div>
          )}

          {jobStatus.status === 'cancelled' && (
            <p className="text-sm text-gray-400">Training cancelled.</p>
          )}

          {jobStatus.status === 'failed' && jobStatus.error && (
            <details open>
              <summary className="text-xs text-red-400 cursor-pointer select-none">⚠ Error (click to collapse)</summary>
              <pre className="mt-1.5 p-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-xs overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{jobStatus.error}</pre>
            </details>
          )}

          {jobStatus.status === 'merge_failed' && (
            <div className="space-y-3">
              {jobStatus.error && (
                <details open>
                  <summary className="text-xs text-red-400 cursor-pointer select-none">⚠ Error (click to collapse)</summary>
                  <pre className="mt-1.5 p-3 bg-red-950 border border-red-800 rounded-lg text-red-300 text-xs overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap">{jobStatus.error}</pre>
                </details>
              )}
              <button onClick={triggerMerge} className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-xl transition-colors">Retry merge</button>
            </div>
          )}

          <div className="border-t border-gray-800 pt-3 space-y-1.5">
            <Row label="File"       value={job.filename} />
            {job.size_bytes != null && <Row label="Size" value={`${(job.size_bytes / 1024).toFixed(1)} KB`} />}
            <Row label="Base model" value={job.base_model_override ? `${profile.display_name} (continued)` : 'Phi-3-mini-4k-instruct (fresh)'} />
          </div>
        </div>
      )}

      {/* ── Training Queue ──────────────────────────────────────────────── */}
      <div className="mt-8 border-t border-gray-800 pt-6">
        <button
          onClick={() => setQueueOpen(o => !o)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-300 hover:text-white transition-colors w-full"
        >
          <span className={`text-xs transition-transform duration-150 ${queueOpen ? 'rotate-90' : ''}`}>▶</span>
          Training Queue
          {queue.length > 0 && (
            <span className="px-2 py-0.5 bg-indigo-600 text-white text-xs rounded-full">{queue.length}</span>
          )}
          <span className="text-xs font-normal text-gray-500 ml-1">Run multiple datasets back to back automatically</span>
        </button>

        {queueOpen && (
          <div className="mt-4 space-y-3">
            {/* Add to queue row */}
            <div className="flex items-center gap-2 p-3 bg-gray-900 border border-gray-800 rounded-xl">
              <select
                value={addingFile}
                onChange={e => setAddingFile(e.target.value)}
                className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">Pick a file from data library…</option>
                {dataFiles.map(f => (
                  <option key={f.filename} value={f.filename}>
                    {f.display_name} ({f.line_count.toLocaleString()} examples)
                  </option>
                ))}
              </select>
              <div className="flex gap-1 shrink-0">
                {EPOCH_OPTIONS.map(n => (
                  <button
                    key={n}
                    onClick={() => setAddingEpochs(n)}
                    className={`w-8 h-7 text-xs font-medium rounded-lg transition-colors ${addingEpochs === n ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}`}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                onClick={addToQueue}
                disabled={!addingFile}
                className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors shrink-0"
              >
                + Add
              </button>
            </div>

            {/* Queue items */}
            {queue.length > 0 ? (
              <>
                <div className="space-y-1.5">
                  {queue.map((item, idx) => (
                    <div key={item.id} className="flex items-center gap-3 px-3 py-2 bg-gray-900 border border-gray-800 rounded-xl text-xs">
                      <span className="text-gray-500 w-4 shrink-0">{idx + 1}.</span>
                      <span className="flex-1 text-gray-300 truncate">{item.displayName}</span>
                      <span className="text-gray-500 shrink-0">{item.epochs} epoch{item.epochs !== 1 ? 's' : ''}</span>
                      <button
                        onClick={() => setQueue(prev => prev.filter(i => i.id !== item.id))}
                        className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
                      >×</button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between text-xs text-gray-500 px-1">
                  <span>
                    {queue.length} run{queue.length !== 1 ? 's' : ''} · {queue.reduce((s, i) => s + i.epochs, 0)} total epochs
                  </span>
                  <button
                    onClick={() => setQueue([])}
                    className="text-gray-500 hover:text-red-400 transition-colors"
                  >
                    Clear all
                  </button>
                </div>
                <button
                  onClick={runQueue}
                  disabled={!!isActive || queueRunning}
                  className="w-full py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
                >
                  {queueRunning ? `Running queue… (${queue.length} left)` : `Run Queue — ${queue.length} run${queue.length !== 1 ? 's' : ''}`}
                </button>
              </>
            ) : (
              <p className="text-xs text-gray-500 text-center py-3">
                Queue is empty — add runs above, then click Run Queue.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Job history */}
      {jobHistory.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-gray-400 mb-3">Job History — {profile.display_name}</h3>
          <div className="space-y-2">
            {jobHistory.map(j => (
              <div key={j.job_id} className="p-3 bg-gray-900 border border-gray-800 rounded-xl text-sm">
                <div className="flex items-center gap-3">
                  <StatusDot status={j.status} />
                  <span className="font-mono text-xs text-gray-500">{j.job_id.slice(0, 8)}…</span>
                  <span className="flex-1 text-gray-400 truncate">{j.filename ?? 'unknown'}</span>
                  {j.epochs != null && j.epochs !== 3 && (
                    <span className="text-xs text-gray-500 shrink-0">{j.epochs}ep</span>
                  )}
                  <span className="text-xs text-gray-500 capitalize shrink-0">{j.status.replace('_', ' ')}</span>
                  {j.created_at && (
                    <span className="text-xs text-gray-500 shrink-0">{new Date(j.created_at).toLocaleString()}</span>
                  )}
                  {j.data_file && !isActive && (
                    <button
                      onClick={() => rerunJob(j.job_id)}
                      title="Re-run with same file and settings"
                      className="text-xs text-gray-500 hover:text-indigo-400 transition-colors shrink-0 font-mono"
                    >↺</button>
                  )}
                  <button
                    onClick={() => deleteJob(j.job_id)}
                    title="Delete job"
                    className="text-gray-500 hover:text-red-400 transition-colors shrink-0"
                  >🗑</button>
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

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FileCard({ item, onRemove }: { item: SelectedFile; onRemove: () => void }) {
  const v = item.validation

  const statusIcon  = v === null ? '⏳' : v.valid === 0 ? '✕' : v.invalid > 0 ? '⚠' : '✓'
  const statusColor = v === null ? 'text-gray-500' : v.valid === 0 ? 'text-red-400' : v.invalid > 0 ? 'text-amber-400' : 'text-green-400'
  const cardBorder  = v === null ? 'border-gray-800' : v.valid === 0 ? 'border-red-900/60' : v.invalid > 0 ? 'border-amber-900/60' : 'border-gray-800'

  return (
    <div className={`p-3 bg-gray-900 border ${cardBorder} rounded-xl text-sm`}>
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 font-bold text-base leading-none ${statusColor}`}>{statusIcon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-gray-200 font-medium truncate">{item.file.name}</p>
          {v === null && <p className="text-xs text-gray-500 mt-0.5">Validating…</p>}
          {v !== null && (
            <div className="mt-0.5 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-400">
                <span className="text-green-400 font-medium">{v.valid.toLocaleString()}</span> valid
                {v.invalid > 0 && (
                  <> · <span className="text-amber-400 font-medium">{v.invalid}</span> invalid</>
                )}
              </span>
              {v.format !== 'unknown' && (
                <span className="px-1.5 py-0.5 bg-gray-800 text-gray-400 text-xs rounded font-mono">
                  {FORMAT_LABEL[v.format]}
                </span>
              )}
            </div>
          )}
          {v !== null && v.errors.length > 0 && (
            <p className="text-xs text-amber-500/80 mt-1">
              ⚠ Lines {v.errors.map(e => e.line).join(', ')}
              {v.invalid > 5 && ` and ${v.invalid - 5} more`}: Invalid JSON
            </p>
          )}
          {v !== null && v.valid === 0 && (
            <p className="text-xs text-red-400 mt-1">No valid examples — this file cannot be used.</p>
          )}
        </div>
        <button onClick={onRemove} className="text-gray-500 hover:text-red-400 transition-colors text-base leading-none mt-0.5 flex-shrink-0">🗑</button>
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: JobStatus }) {
  const colors: Record<JobStatus, string> = {
    queued:       'bg-yellow-500',
    training:     'bg-blue-500 animate-pulse',
    complete:     'bg-green-500',
    failed:       'bg-red-500',
    merging:      'bg-purple-500 animate-pulse',
    merged:       'bg-green-400',
    merge_failed: 'bg-red-500',
    cancelled:    'bg-gray-500',
  }
  return <span className={`w-2.5 h-2.5 rounded-full inline-block flex-shrink-0 ${colors[status]}`} />
}

function Spinner() {
  return (
    <svg className="w-4 h-4 animate-spin text-blue-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
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

function LossSparkline({ losses }: { losses: number[] }) {
  const W = 120, H = 28
  const max = Math.max(...losses)
  const min = Math.min(...losses)
  const range = max - min || 0.001
  const pts = losses.map((l, i) => {
    const x = (i / (losses.length - 1)) * W
    const y = H - ((l - min) / range) * (H - 2) - 1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <div className="flex items-center gap-2 mt-2 text-xs text-gray-500">
      <span>Loss</span>
      <svg width={W} height={H} className="overflow-visible">
        <polyline points={pts} fill="none" stroke="#818cf8" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
      <span className="font-mono">{losses[losses.length - 1].toFixed(3)}</span>
      {losses.length > 1 && (
        <span className={losses[losses.length - 1] < losses[0] ? 'text-green-500' : 'text-red-400'}>
          {losses[losses.length - 1] < losses[0] ? '↓' : '↑'}
        </span>
      )}
    </div>
  )
}
