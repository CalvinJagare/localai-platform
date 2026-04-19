import { useState, useEffect, useRef } from 'react'
import { API, type Profile, type ProfileColor } from '../App'

const DOT: Record<ProfileColor, string> = {
  indigo:  'bg-indigo-500',
  emerald: 'bg-emerald-500',
  amber:   'bg-amber-500',
  rose:    'bg-rose-500',
  violet:  'bg-violet-500',
  sky:     'bg-sky-500',
  teal:    'bg-teal-500',
}

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface Props {
  profile: Profile | null
}

export default function ChatPage({ profile }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Load / clear chat history when profile switches
  useEffect(() => {
    if (!profile) { setMessages([]); return }
    try {
      const stored = localStorage.getItem(`chat_history_${profile.id}`)
      setMessages(stored ? JSON.parse(stored) : [])
    } catch {
      setMessages([])
    }
  }, [profile?.id])

  // Persist messages whenever they change
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

  async function sendMessage() {
    if (!input.trim() || streaming || !profile?.current_model) return

    const userMsg: Message = { role: 'user', content: input.trim() }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setStreaming(true)
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])

    try {
      const resp = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: userMsg.content, model: profile.current_model }),
      })

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value)
        const lines = text.split('\n').filter(l => l.startsWith('data: '))

        for (const line of lines) {
          try {
            const chunk = JSON.parse(line.slice(6))
            if (chunk.token) {
              setMessages(prev => {
                const updated = [...prev]
                updated[updated.length - 1] = {
                  ...updated[updated.length - 1],
                  content: updated[updated.length - 1].content + chunk.token,
                }
                return updated
              })
            }
          } catch {
            // ignore malformed chunks
          }
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
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

      {/* No model yet */}
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

      {/* No profile selected */}
      {!profile && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-gray-500 text-sm">Select a profile from the sidebar to start chatting.</p>
        </div>
      )}

      {/* Chat area — only shown when model exists */}
      {hasModel && (
        <>
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            {messages.length === 0 && (
              <p className="text-center text-gray-500 mt-16 text-sm">
                Start chatting with {profile?.display_name}
              </p>
            )}
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div
                  className={`max-w-2xl px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap
                    ${msg.role === 'user'
                      ? 'bg-indigo-600 text-white rounded-br-sm'
                      : 'bg-gray-800 text-gray-100 rounded-bl-sm'}`}
                >
                  {msg.content || (streaming && msg.role === 'assistant' ? '▌' : '')}
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
                placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
                rows={2}
                disabled={streaming}
                className="flex-1 resize-none bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
              />
              <button
                onClick={sendMessage}
                disabled={streaming || !input.trim()}
                className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium rounded-xl transition-colors"
              >
                {streaming ? '…' : 'Send'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
