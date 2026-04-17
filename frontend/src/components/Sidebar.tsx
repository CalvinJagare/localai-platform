import type { Page } from '../App'

interface Props {
  current: Page
  onNavigate: (p: Page) => void
}

const links: { id: Page; label: string; icon: string }[] = [
  { id: 'chat', label: 'Chat', icon: '💬' },
  { id: 'training', label: 'Training', icon: '🧠' },
  { id: 'health', label: 'Health', icon: '📊' },
]

export default function Sidebar({ current, onNavigate }: Props) {
  return (
    <aside className="w-52 bg-gray-900 border-r border-gray-800 flex flex-col">
      <div className="px-4 py-5 border-b border-gray-800">
        <h1 className="text-lg font-bold text-white">LocalAI</h1>
        <p className="text-xs text-gray-400 mt-0.5">Platform</p>
      </div>
      <nav className="flex-1 p-3 space-y-1">
        {links.map(({ id, label, icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors cursor-pointer
              ${current === id
                ? 'bg-indigo-600 text-white'
                : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      <div className="px-4 py-3 border-t border-gray-800 text-xs text-gray-500">
        Backend: localhost:8000
      </div>
    </aside>
  )
}
