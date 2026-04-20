import { useState, useEffect, useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { API } from '../lib/server'
import type { Profile, ProfileColor } from '../App'
import { useToast } from '../components/Toast'

const TOOL_LABELS: Record<string, string> = {
  get_datetime: 'Date & Time',
  calculate:    'Calculator',
  web_search:   'Web Search',
  wiki_search:  'Wikipedia',
  get_weather:  'Weather',
}

const DOT: Record<ProfileColor, string> = {
  indigo:  'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  violet:  'bg-violet-500',
  sky:     'bg-sky-500',
  teal:    'bg-teal-500',
}

interface ToolActivity {
  tool: string
  args: Record<string, unknown>
  result?: string
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  tools?: ToolActivity[]
  sources?: string[]   // RAG document sources used
}

interface Props {
  profile: Profile | null
  onMessageSent?: () => void
}

// ---------------------------------------------------------------------------
// Markdown renderer — consistent dark-theme styling
// ---------------------------------------------------------------------------
/* eslint-disable @typescript-eslint/no-explicit-any */
function MdContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p:          (p: any) => <p className="mb-2 last:mb-0">{p.children}</p>,
        ul:         (p: any) => <ul className="list-disc list-inside mb-2 space-y-0.5 pl-1">{p.children}</ul>,
        ol:         (p: any) => <ol className="list-decimal list-inside mb-2 space-y-0.5 pl-1">{p.children}</ol>,
        li:         (p: any) => <li>{p.children}</li>,
        strong:     (p: any) => <strong className="font-semibold">{p.children}</strong>,
        em:         (p: any) => <em className="italic">{p.children}</em>,
        h1:         (p: any) => <h1 className="text-base font-bold mb-2 mt-1">{p.children}</h1>,
        h2:         (p: any) => <h2 className="text-sm font-bold mb-1 mt-1">{p.children}</h2>,
        h3:         (p: any) => <h3 className="text-sm font-semibold mb-1 mt-1">{p.children}</h3>,
        a:          (p: any) => <a href={p.href} className="text-indigo-400 hover:underline" target="_blank" rel="noopener noreferrer">{p.children}</a>,
        blockquote: (p: any) => <blockquote className="border-l-2 border-gray-500 pl-3 text-gray-400 my-2 italic">{p.children}</blockquote>,
        hr:         ()       => <hr className="border-gray-700 my-3" />,
        table:      (p: any) => <div className="overflow-x-auto my-2"><table className="text-xs border-collapse w-full">{p.children}</table></div>,
        thead:      (p: any) => <thead className="bg-gray-800">{p.children}</thead>,
        th:         (p: any) => <th className="border border-gray-700 px-2 py-1 font-medium text-left">{p.children}</th>,
        td:         (p: any) => <td className="border border-gray-700 px-2 py-1">{p.children}</td>,
        pre:        (p: any) => <pre className="bg-gray-950 border border-gray-700 rounded-lg p-3 overflow-x-auto text-xs font-mono my-2 whitespace-pre">{p.children}</pre>,
        code:       (p: any) => p.className
          ? <code className={`text-xs font-mono ${p.className}`}>{p.children}</code>
          : <code className="bg-gray-700/60 px-1 py-0.5 rounded text-xs font-mono">{p.children}</code>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export default function ChatPage({ profile, onMessageSent }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput]       = useState('')
  const [streaming, setStreaming] = useState(false)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const { addToast } = useToast()

  // Load / clear history when profile switches
  useEffect(() => {
    if (!profile) { setMessages([]); return }
    try {
      const stored = localStorage.getItem(`chat_history_${profile.id}`)
      setMessages(stored ? JSON.parse(stored) : [])
    } catch { setMessages([]) }
  }, [profile?.id])

  // Persist messages
  useEffect(() => {
    if (!profile) return
    localStorage.setItem(`chat_history_${profile.id}`, JSON.stringify(messages))
  }, [messages, profile?.id])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function clearChat() {
    if (!profile) return
    setMessages([])
    localStorage.removeItem(`chat_history_${profile.id}`)
  }

  async function copyMessage(idx: number, content: string) {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 2000)
      addToast('success', 'Copied to clipboard')
    } catch {
      addToast('error', 'Copy failed')
    }
  }

  async function sendMessage() {
    if (!input.trim() || streaming || !profile?.current_model) return

    const userMsg: Message = { role: 'user', content: input.trim() }
    onMessageSent?.()
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    try {
      const resp = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [...messages, userMsg], model: profile.current_model, profile_id: profile.id }),
      })

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const lines = decoder.decode(value).split('\n').filter(l => l.startsWith('data: '))

        for (const line of lines) {
          try {
            const chunk = JSON.parse(line.slice(6))
            if (chunk.type === 'rag_sources') {
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = { ...updated[updated.length - 1], sources: chunk.sources }
                return updated
              })
            } else if (chunk.type === 'tool_call') {
              setMessages(prev => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                updated[updated.length - 1] = {
                  ...last,
                  tools: [...(last.tools ?? []), { tool: chunk.tool, args: chunk.args }],
                }
                return updated
              })
            } else if (chunk.type === 'tool_result') {
              setMessages(prev => {
                const updated = [...prev]
                const last = updated[updated.length - 1]
                updated[updated.length - 1] = {
                  ...last,
                  tools: (last.tools ?? []).map(t =>
                    t.tool === chunk.tool && t.result === undefined
                      ? { ...t, result: chunk.result }
                      : t
                  ),
                }
                return updated
              })
            } else if (chunk.token !== undefined) {
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: updated[updated.length - 1].content + chunk.token,
                }
                return updated
              })
            }
          } catch { /* ignore malformed */ }
        }
      }
    } catch (err) {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { ...updated[updated.length - 1], content: `Error: ${String(err)}` }
        return updated
      })
    } finally {
      setStreaming(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
  }

  const hasModel = Boolean(profile?.current_model)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-800 bg-gray-900">
        <h2 className="text-base font-semibold">Chat</h2>

        {profile && (
          <div className="ml-auto flex items-center gap-2 text-sm text-gray-400">
            <span className={`w-2.5 h-2.5 rounded-full ${DOT[profile.color]}`} />
            <span className="text-gray-200 font-medium">{profile.display_name}</span>
            {profile.current_model && (
              <>
                <span className="text-gray-600">·</span>
                <span className="font-mono text-xs text-gray-400">{profile.current_model}</span>
              </>
            )}
          </div>
        )}

        {messages.length > 0 && (
          <button
            onClick={clearChat}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors shrink-0 ml-3"
          >
            Clear
          </button>
        )}
      </div>

      {/* No model */}
      {!hasModel && profile && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-3">
            <div className="text-4xl">🧠</div>
            <p className="text-gray-300 font-medium">No model trained for {profile.display_name} yet</p>
            <p className="text-sm text-gray-500">
              Go to <span className="text-indigo-400">Training</span> to upload data and fine-tune a model.
            </p>
          </div>
        </div>
      )}

      {/* No profile */}
      {!profile && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-500 text-sm">Select a profile from the sidebar to start chatting.</p>
        </div>
      )}

      {/* Chat area */}
      {hasModel && (
        <>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {messages.length === 0 && (
              <div className="flex flex-col items-center mt-16 gap-6">
                <p className="text-gray-500 text-sm">
                  Mission comms open with <span className="text-gray-300 font-medium">{profile?.display_name}</span>
                </p>
                <div className="flex flex-wrap gap-2 justify-center max-w-lg">
                  {['What can you help me with?', 'Summarise your training data', 'Tell me something unexpected', 'What are your capabilities?'].map(chip => (
                    <button
                      key={chip}
                      onClick={() => setInput(chip)}
                      className="px-3 py-1.5 text-xs text-gray-400 border border-gray-700 rounded-full
                        hover:border-indigo-500/60 hover:text-indigo-300 transition-colors"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`group relative max-w-2xl px-4 py-3 rounded-2xl text-sm leading-relaxed
                    ${msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : 'bg-gray-800 text-gray-100 rounded-bl-sm'}`}
                >
                  {/* Tool call indicators */}
                  {msg.tools && msg.tools.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.tools.map((t, ti) => (
                        <details key={ti} className="text-xs">
                          <summary className="cursor-pointer select-none text-gray-400 flex items-center gap-1.5 list-none">
                            <span>{t.result !== undefined ? '✓' : '⟳'}</span>
                            <span className="text-gray-300 font-medium">{TOOL_LABELS[t.tool] ?? t.tool}</span>
                            {t.args && Object.keys(t.args).length > 0 && (
                              <span className="text-gray-500 truncate max-w-48">
                                {Object.values(t.args).join(', ')}
                              </span>
                            )}
                          </summary>
                          {t.result && (
                            <pre className="mt-1.5 p-2 bg-gray-900/70 border border-gray-700 rounded-lg text-gray-400 whitespace-pre-wrap overflow-x-auto max-h-32 overflow-y-auto">
                              {t.result}
                            </pre>
                          )}
                        </details>
                      ))}
                    </div>
                  )}

                  {/* Message content */}
                  {msg.role === 'assistant' ? (
                    msg.content
                      ? <MdContent content={msg.content} />
                      : streaming ? <span className="animate-pulse text-gray-400">▌</span> : null
                  ) : (
                    <span className="whitespace-pre-wrap">{msg.content}</span>
                  )}

                  {/* RAG sources */}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-gray-700/50 flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs text-gray-500">📄 Sources:</span>
                      {msg.sources.map(s => (
                        <span key={s} className="text-xs px-1.5 py-0.5 bg-gray-700/50 text-gray-400 rounded">{s}</span>
                      ))}
                    </div>
                  )}

                  {/* Copy button — assistant messages only, visible on hover */}
                  {msg.role === 'assistant' && msg.content && (
                    <button
                      onClick={() => copyMessage(i, msg.content)}
                      className="absolute -top-2 -right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 bg-gray-700 hover:bg-gray-600 rounded-lg text-xs text-gray-300"
                      title="Copy"
                    >
                      {copiedIdx === i ? '✓' : '⎘'}
                    </button>
                  )}
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          <div className="px-6 py-4 border-t border-gray-800 bg-gray-900">
            <div className="flex gap-3">
              <textarea
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ground control to skAIler… (Enter to send, Shift+Enter for newline)"
                rows={2}
                disabled={streaming}
                className="flex-1 resize-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={streaming || !input.trim()}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
              >
                {streaming ? '…' : 'Transmit ▶'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
