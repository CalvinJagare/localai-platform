import { useState } from 'react'
import Sidebar from './components/Sidebar'
import ChatPage from './pages/ChatPage'
import TrainingPage from './pages/TrainingPage'
import HealthPage from './pages/HealthPage'

export type Page = 'chat' | 'training' | 'health'

export default function App() {
  const [page, setPage] = useState<Page>('chat')

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <Sidebar current={page} onNavigate={setPage} />
      <main className="flex-1 overflow-auto">
        {page === 'chat' && <ChatPage />}
        {page === 'training' && <TrainingPage />}
        {page === 'health' && <HealthPage />}
      </main>
    </div>
  )
}
