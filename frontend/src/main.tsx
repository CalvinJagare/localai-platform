import { StrictMode, Component, type ReactNode, type ErrorInfo } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[skAIler] render error:', error, info)
  }

  render() {
    if (this.state.error) {
      const err = this.state.error as Error
      return (
        <div className="fixed inset-0 bg-gray-950 text-gray-100 flex flex-col items-center justify-center p-8 gap-4">
          <div className="text-2xl font-bold text-red-400">Something went wrong</div>
          <div className="font-mono text-sm text-gray-400 max-w-xl text-center break-all">{err.message}</div>
          <button
            onClick={() => window.location.reload()}
            className="mt-4 px-6 py-2 bg-indigo-600 hover:bg-indigo-500 text-sm font-medium rounded-lg transition-colors"
          >
            Reload
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
