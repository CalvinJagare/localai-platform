import { useState, useEffect, useMemo } from 'react'

const API = 'http://localhost:8000'

interface DataFile {
  filename: string
  display_name: string
  size_bytes: number
  line_count: number
  created_at: string
}

interface FileGroup {
  display_name: string
  job_count: number
  size_bytes: number
  line_count: number
  latest_at: string
  filenames: string[]
}

function groupFiles(files: DataFile[]): FileGroup[] {
  const map = new Map<string, FileGroup>()
  for (const f of files) {
    const g = map.get(f.display_name)
    if (g) {
      g.job_count++
      g.filenames.push(f.filename)
      if (f.created_at > g.latest_at) g.latest_at = f.created_at
    } else {
      map.set(f.display_name, {
        display_name: f.display_name,
        job_count: 1,
        size_bytes: f.size_bytes,
        line_count: f.line_count,
        latest_at: f.created_at,
        filenames: [f.filename],
      })
    }
  }
  return Array.from(map.values())
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function DataPage() {
  const [files, setFiles] = useState<DataFile[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ group: FileGroup; records: object[] } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

  const groups = useMemo(() => groupFiles(files), [files])

  async function fetchFiles() {
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${API}/data/files`)
      if (!resp.ok) throw new Error(resp.statusText)
      setFiles(await resp.json())
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { fetchFiles() }, [])

  async function openPreview(group: FileGroup) {
    setPreviewLoading(true)
    setPreview({ group, records: [] })
    try {
      const resp = await fetch(`${API}/data/files/${encodeURIComponent(group.filenames[0])}/preview`)
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const data = await resp.json()
      setPreview({ group, records: data.records })
    } catch (err) {
      setPreview({ group, records: [] })
      setError(`Preview failed: ${String(err)}`)
    } finally {
      setPreviewLoading(false)
    }
  }

  async function deleteGroup(group: FileGroup) {
    if (!window.confirm(
      `Delete all ${group.job_count} cop${group.job_count === 1 ? 'y' : 'ies'} of "${group.display_name}"?\n\nCompleted training jobs and their models will not be affected.`
    )) return
    try {
      for (const filename of group.filenames) {
        const resp = await fetch(`${API}/data/files/${encodeURIComponent(filename)}`, { method: 'DELETE' })
        if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      }
      setFiles(prev => prev.filter(f => !group.filenames.includes(f.filename)))
    } catch (err) {
      setError(`Delete failed: ${String(err)}`)
    }
  }

  return (
    <div className="p-8 max-w-3xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Training Data</h2>
      <p className="text-sm text-gray-400 mb-8">
        All <code className="bg-gray-800 px-1 rounded text-gray-200">.jsonl</code> files uploaded for fine-tuning.
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="text-sm text-gray-500 text-center mt-16">
          No training files yet. Upload a <code className="bg-gray-800 px-1 rounded">.jsonl</code> file on the Training page.
        </div>
      ) : (
        <>
          <p className="text-xs text-gray-600 mb-3">
            Deleting a file does not affect completed training jobs or their models.
          </p>
          <div className="space-y-2">
            {groups.map(g => (
              <div
                key={g.display_name}
                className="flex items-center gap-4 p-4 bg-gray-900 border border-gray-800 rounded-xl text-sm"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-gray-200 font-medium truncate">{g.display_name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {g.line_count} example{g.line_count !== 1 ? 's' : ''} · {formatSize(g.size_bytes)}
                    {' · '}
                    <span className={g.job_count > 1 ? 'text-indigo-400' : ''}>
                      Used in {g.job_count} training job{g.job_count !== 1 ? 's' : ''}
                    </span>
                    {' · '}
                    {new Date(g.latest_at).toLocaleString()}
                  </p>
                </div>
                <button
                  onClick={() => openPreview(g)}
                  className="px-3 py-1.5 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg transition-colors shrink-0"
                >
                  Preview
                </button>
                <button
                  onClick={() => deleteGroup(g)}
                  title="Delete file copies — does not affect completed training jobs"
                  className="text-gray-600 hover:text-red-400 transition-colors text-base shrink-0"
                >
                  🗑
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Preview modal */}
      {preview && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setPreview(null)}
        >
          <div
            className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
              <div>
                <p className="text-sm font-semibold text-gray-200">{preview.group.display_name}</p>
                <p className="text-xs text-gray-500 mt-0.5">First 5 examples</p>
              </div>
              <button
                onClick={() => setPreview(null)}
                className="text-gray-500 hover:text-gray-200 text-lg leading-none transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-3">
              {previewLoading ? (
                <p className="text-sm text-gray-500">Loading…</p>
              ) : preview.records.length === 0 ? (
                <p className="text-sm text-gray-500">No records found.</p>
              ) : (
                preview.records.map((rec, i) => (
                  <div key={i} className="bg-gray-950 border border-gray-800 rounded-xl p-3">
                    <p className="text-xs text-gray-600 mb-1.5">Example {i + 1}</p>
                    <pre className="text-xs text-gray-300 whitespace-pre-wrap overflow-x-auto">
                      {JSON.stringify(rec, null, 2)}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
