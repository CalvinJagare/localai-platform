import { useState, useEffect, useRef } from 'react'
import { API } from '../lib/server'
import type { Profile, ProfileColor } from '../App'

const DOT: Record<ProfileColor, string> = {
  indigo:  'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  violet:  'bg-violet-500',
  sky:     'bg-sky-500',
  teal:    'bg-teal-500',
}

interface DocInfo {
  doc_id: string
  filename: string
  chunk_count: number
  size_bytes: number
  created_at: string
}

interface Props {
  profile: Profile | null
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export default function DocumentsPage({ profile }: Props) {
  const [docs, setDocs]           = useState<DocInfo[]>([])
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError]         = useState<string | null>(null)
  const [dragOver, setDragOver]   = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!profile) { setDocs([]); return }
    setError(null)
    fetch(`${API}/profiles/${profile.id}/rag`)
      .then(r => r.json())
      .then(setDocs)
      .catch(() => setDocs([]))
  }, [profile?.id])

  async function uploadFile(file: File) {
    if (!profile) return
    const ext = file.name.split('.').pop()?.toLowerCase()
    if (!['pdf', 'txt', 'md'].includes(ext ?? '')) {
      setError('Only PDF, .txt, and .md files are supported.')
      return
    }
    setUploading(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const resp = await fetch(`${API}/profiles/${profile.id}/rag`, { method: 'POST', body: fd })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const created: DocInfo = await resp.json()
      setDocs(prev => [...prev, created])
    } catch (err) {
      setError(String(err))
    } finally {
      setUploading(false)
    }
  }

  async function deleteDoc(doc_id: string) {
    if (!profile) return
    setDeletingId(doc_id)
    setError(null)
    try {
      const resp = await fetch(`${API}/profiles/${profile.id}/rag/${doc_id}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      setDocs(prev => prev.filter(d => d.doc_id !== doc_id))
    } catch (err) {
      setError(String(err))
    } finally {
      setDeletingId(null)
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) uploadFile(file)
  }

  function onFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) uploadFile(file)
    e.target.value = ''
  }

  const totalChunks = docs.reduce((s, d) => s + d.chunk_count, 0)

  if (!profile) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <p className="text-gray-500 text-sm">Select a profile from the sidebar.</p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-xl font-semibold">Documents</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            Upload PDFs, text, or Markdown files. The model will search these when answering questions.
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <span className={`w-2.5 h-2.5 rounded-full ${DOT[profile.color]}`} />
          <span className="text-gray-200 font-medium">{profile.display_name}</span>
        </div>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-950 border border-red-700 rounded-lg text-sm text-red-300">{error}</div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => !uploading && fileInputRef.current?.click()}
        className={`mb-6 border-2 border-dashed rounded-xl px-6 py-10 text-center cursor-pointer transition-colors select-none
          ${dragOver ? 'border-indigo-500 bg-indigo-950/30' : 'border-gray-700 hover:border-gray-500'}
          ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.txt,.md"
          className="hidden"
          onChange={onFileInput}
          disabled={uploading}
        />
        {uploading ? (
          <p className="text-gray-400 text-sm">Parsing and indexing…</p>
        ) : (
          <>
            <p className="text-gray-300 font-medium mb-1">Drop a file here or click to browse</p>
            <p className="text-xs text-gray-500">PDF · TXT · Markdown</p>
          </>
        )}
      </div>

      {/* Document list */}
      {docs.length > 0 && (
        <div className="space-y-2 mb-4">
          {docs.map(doc => (
            <div key={doc.doc_id} className="flex items-center gap-3 p-3 bg-gray-900 border border-gray-800 rounded-xl">
              <span className="text-lg">
                {doc.filename.endsWith('.pdf') ? '📕' : doc.filename.endsWith('.md') ? '📝' : '📄'}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-100 truncate">{doc.filename}</p>
                <p className="text-xs text-gray-500">
                  {doc.chunk_count} {doc.chunk_count === 1 ? 'chunk' : 'chunks'} · {fmtBytes(doc.size_bytes)}
                </p>
              </div>
              <button
                onClick={() => deleteDoc(doc.doc_id)}
                disabled={deletingId === doc.doc_id}
                title="Remove"
                className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors text-sm disabled:opacity-40"
              >
                🗑
              </button>
            </div>
          ))}
        </div>
      )}

      {docs.length === 0 && !uploading && (
        <p className="text-center text-gray-600 py-8 text-sm">No documents yet — drop a file above to get started.</p>
      )}

      {docs.length > 0 && (
        <p className="text-xs text-gray-500 text-center">
          {totalChunks} chunks across {docs.length} {docs.length === 1 ? 'document' : 'documents'}
        </p>
      )}
    </div>
  )
}
