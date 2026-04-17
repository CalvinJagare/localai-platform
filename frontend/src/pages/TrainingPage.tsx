import { useState, useRef } from 'react'

const API = 'http://localhost:8000'

interface UploadResult {
  job_id: string
  filename: string
  size_bytes: number
  status: string
}

export default function TrainingPage() {
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  async function uploadFile(file: File) {
    if (!file.name.endsWith('.jsonl')) {
      setError('Only .jsonl files are supported.')
      return
    }
    setError(null)
    setResult(null)
    setUploading(true)

    try {
      const form = new FormData()
      form.append('file', file)
      const resp = await fetch(`${API}/train`, { method: 'POST', body: form })
      if (!resp.ok) {
        const data = await resp.json()
        throw new Error(data.detail ?? resp.statusText)
      }
      setResult(await resp.json())
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

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Training Data Upload</h2>
      <p className="text-sm text-gray-400 mb-8">
        Upload a <code className="bg-gray-800 px-1 rounded text-gray-200">.jsonl</code> file to queue a fine-tuning job.
      </p>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`border-2 border-dashed rounded-2xl p-12 text-center cursor-pointer transition-colors
          ${dragging ? 'border-indigo-500 bg-indigo-950' : 'border-gray-700 hover:border-gray-500 bg-gray-900'}`}
      >
        <input ref={inputRef} type="file" accept=".jsonl" onChange={onFileChange} className="hidden" />
        <div className="text-4xl mb-3">📂</div>
        <p className="text-sm text-gray-300 font-medium">
          {uploading ? 'Uploading…' : 'Drop a .jsonl file here or click to browse'}
        </p>
        <p className="text-xs text-gray-500 mt-1">Accepted format: .jsonl</p>
      </div>

      {/* Error */}
      {error && (
        <div className="mt-4 p-4 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Success */}
      {result && (
        <div className="mt-4 p-5 bg-gray-900 border border-gray-700 rounded-xl space-y-2 text-sm">
          <div className="flex items-center gap-2 text-green-400 font-medium mb-3">
            <span>✓</span> Upload successful
          </div>
          <Row label="Job ID" value={result.job_id} mono />
          <Row label="Filename" value={result.filename} />
          <Row label="Size" value={`${(result.size_bytes / 1024).toFixed(1)} KB`} />
          <Row label="Status" value={result.status} />
        </div>
      )}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between">
      <span className="text-gray-400">{label}</span>
      <span className={`text-gray-100 ${mono ? 'font-mono text-xs' : ''}`}>{value}</span>
    </div>
  )
}
