interface Props {
  statusText: string
}

export default function SplashScreen({ statusText }: Props) {
  return (
    <div
      data-tauri-drag-region
      className="flex flex-col items-center justify-center h-screen bg-gray-950 select-none"
    >
      <div className="mb-10 text-center">
        <div className="text-4xl font-bold text-white tracking-tight">LocalAI</div>
        <div className="text-sm text-gray-500 mt-1 tracking-widest uppercase">Platform</div>
      </div>

      <div className="relative w-12 h-12 mb-8">
        <div className="absolute inset-0 rounded-full border-2 border-indigo-500/20 animate-ping" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-indigo-500 animate-spin" />
      </div>

      <p className="text-sm text-gray-400 max-w-xs text-center min-h-[1.5rem] transition-all duration-300">
        {statusText}
      </p>
    </div>
  )
}
