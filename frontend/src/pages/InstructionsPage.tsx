import { useState, useEffect, useRef } from 'react'
import { API } from '../lib/server'
import type { Profile } from '../App'

interface InstructionFile {
  filename: string
  size_bytes: number
  word_count: number
  content: string
}

interface Props {
  profile: Profile | null
}

export default function InstructionsPage({ profile }: Props) {
  const [files, setFiles]           = useState<InstructionFile[]>([])
  const [loading, setLoading]       = useState(false)
  const [error, setError]           = useState<string | null>(null)
  const [editing, setEditing]       = useState<string | null>(null)   // filename being edited
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving]         = useState(false)
  const [creating, setCreating]     = useState(false)
  const [newFilename, setNewFilename] = useState('')
  const [newContent, setNewContent]   = useState('')
  const [expanded, setExpanded]     = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function fetchFiles() {
    if (!profile) return
    setLoading(true)
    setError(null)
    try {
      const resp = await fetch(`${API}/profiles/${profile.id}/instructions`)
      if (!resp.ok) throw new Error(resp.statusText)
      setFiles(await resp.json())
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setFiles([])
    setEditing(null)
    setCreating(false)
    setExpanded(null)
    fetchFiles()
  }, [profile?.id])

  async function saveEdit(filename: string) {
    if (!profile) return
    setSaving(true)
    try {
      const form = new FormData()
      form.append('content', editContent)
      const resp = await fetch(`${API}/profiles/${profile.id}/instructions/${encodeURIComponent(filename)}`, {
        method: 'PUT',
        body: form,
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const updated: InstructionFile = await resp.json()
      setFiles(prev => prev.map(f => f.filename === filename ? updated : f))
      setEditing(null)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  async function deleteFile(filename: string) {
    if (!profile) return
    if (!window.confirm(`Delete "${filename}"?`)) return
    try {
      const resp = await fetch(`${API}/profiles/${profile.id}/instructions/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      setFiles(prev => prev.filter(f => f.filename !== filename))
      if (editing === filename) setEditing(null)
      if (expanded === filename) setExpanded(null)
    } catch (err) {
      setError(String(err))
    }
  }

  async function createInline() {
    if (!profile || !newFilename.trim()) return
    setSaving(true)
    setError(null)
    try {
      const form = new FormData()
      form.append('filename', newFilename.trim())
      form.append('content', newContent)
      const resp = await fetch(`${API}/profiles/${profile.id}/instructions`, {
        method: 'POST',
        body: form,
      })
      if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
      const created: InstructionFile = await resp.json()
      setFiles(prev => [...prev, created])
      setCreating(false)
      setNewFilename('')
      setNewContent('')
      setExpanded(created.filename)
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  async function uploadFile(fileList: FileList | null) {
    if (!profile || !fileList) return
    setError(null)
    for (const file of Array.from(fileList)) {
      if (!file.name.endsWith('.md')) { setError('Only .md files are accepted.'); continue }
      const form = new FormData()
      form.append('file', file)
      try {
        const resp = await fetch(`${API}/profiles/${profile.id}/instructions`, { method: 'POST', body: form })
        if (!resp.ok) throw new Error((await resp.json()).detail ?? resp.statusText)
        const created: InstructionFile = await resp.json()
        setFiles(prev => {
          const exists = prev.find(f => f.filename === created.filename)
          return exists ? prev.map(f => f.filename === created.filename ? created : f) : [...prev, created]
        })
      } catch (err) {
        setError(`Upload failed for ${file.name}: ${String(err)}`)
      }
    }
  }

  if (!profile) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500 text-sm">Select a profile from the sidebar.</p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-2xl mx-auto">
      <h2 className="text-xl font-semibold mb-1">Instructions</h2>
      <p className="text-sm text-gray-400 mb-2">
        Markdown files injected as system prompt before every chat with this profile.
      </p>

      {/* Profile badge */}
      <div className="mb-6 inline-flex items-center gap-2 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm">
        <span className="text-gray-400">Profile:</span>
        <span className="font-medium text-gray-200">{profile.display_name}</span>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-950 border border-red-700 rounded-xl text-sm text-red-300">{error}</div>
      )}

      {/* Action bar */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() => { setCreating(true); setNewFilename(''); setNewContent('') }}
          disabled={creating}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          + New instruction
        </button>
        <button
          onClick={() => fileInputRef.current?.click()}
          className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-lg transition-colors"
        >
          Upload .md
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md"
          multiple
          onChange={e => uploadFile(e.target.files)}
          className="hidden"
        />
      </div>

      {/* Inline create form */}
      {creating && (
        <div className="mb-4 p-4 bg-gray-900 border border-indigo-800 rounded-xl space-y-3">
          <input
            autoFocus
            value={newFilename}
            onChange={e => setNewFilename(e.target.value)}
            placeholder="filename.md"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
          />
          <textarea
            value={newContent}
            onChange={e => setNewContent(e.target.value)}
            placeholder={`# Instructions\n\nYou are a helpful assistant for ${profile.display_name}.\n\nAlways respond in a professional tone.`}
            rows={10}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono resize-y"
          />
          <div className="flex gap-2">
            <button
              onClick={createInline}
              disabled={!newFilename.trim() || saving}
              className="flex-1 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-white font-medium transition-colors"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="flex-1 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* File list */}
      {loading ? (
        <p className="text-sm text-gray-500">Loading…</p>
      ) : files.length === 0 && !creating ? (
        <div className="text-center py-16 text-sm text-gray-500">
          <p className="text-2xl mb-3">📋</p>
          <p>No instructions yet.</p>
          <p className="mt-1 text-gray-500">Create one above or upload a .md file.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {files.map(f => (
            <div key={f.filename} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">

              {/* Header row */}
              <div className="flex items-center gap-3 px-4 py-3">
                <button
                  onClick={() => setExpanded(expanded === f.filename ? null : f.filename)}
                  className="flex-1 flex items-center gap-3 text-left min-w-0"
                >
                  <span className="text-gray-500 text-xs">{expanded === f.filename ? '▾' : '▸'}</span>
                  <span className="font-mono text-sm text-gray-200 font-medium truncate">{f.filename}</span>
                  <span className="text-xs text-gray-500 shrink-0">{f.word_count} words</span>
                </button>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => { setEditing(f.filename); setEditContent(f.content); setExpanded(f.filename) }}
                    title="Edit"
                    className="px-2.5 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 hover:text-gray-200 rounded-lg transition-colors"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteFile(f.filename)}
                    title="Delete"
                    className="p-1.5 text-gray-500 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors"
                  >
                    🗑
                  </button>
                </div>
              </div>

              {/* Expanded: preview or editor */}
              {expanded === f.filename && (
                <div className="border-t border-gray-800">
                  {editing === f.filename ? (
                    <div className="p-4 space-y-3">
                      <textarea
                        autoFocus
                        value={editContent}
                        onChange={e => setEditContent(e.target.value)}
                        rows={12}
                        className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono resize-y"
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEdit(f.filename)}
                          disabled={saving}
                          className="flex-1 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-white font-medium transition-colors"
                        >
                          {saving ? 'Saving…' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditing(null)}
                          className="flex-1 py-2 text-sm bg-gray-800 hover:bg-gray-700 rounded-lg text-gray-300 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <pre className="px-4 py-3 text-xs text-gray-400 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
                      {f.content || <span className="text-gray-500 italic">Empty file</span>}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {files.length > 0 && (
        <p className="mt-4 text-xs text-gray-500">
          Files are injected in alphabetical order — prefix filenames with numbers to control order (e.g. <span className="font-mono">01_tone.md</span>, <span className="font-mono">02_products.md</span>).
        </p>
      )}
    </div>
  )
}
