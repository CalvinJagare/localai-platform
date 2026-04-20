import { useEffect, useRef, useState } from 'react'
import type { Page } from '../App'

const SECTION: Record<Page, string> = {
  chat:         'AI Communications',
  training:     'Training Hub',
  data:         'Data Library',
  profiles:     'Mission Profiles',
  instructions: 'Instructions',
  documents:    'Knowledge Archives',
  models:       'Model Fleet',
  settings:     'Configuration',
  health:       'System Health',
}

interface Props {
  page: Page
}

export default function TopBar({ page }: Props) {
  const [elapsed, setElapsed] = useState('00:00:00')
  const t0 = useRef(Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      const e  = Math.floor((Date.now() - t0.current) / 1000)
      const hh = String(Math.floor(e / 3600)).padStart(2, '0')
      const mm = String(Math.floor((e % 3600) / 60)).padStart(2, '0')
      const ss = String(e % 60).padStart(2, '0')
      setElapsed(`${hh}:${mm}:${ss}`)
    }, 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="col-span-2 flex items-center bg-gray-900 border-b border-gray-700 z-20 h-12">

      {/* Brand — width matches sidebar */}
      {/* data-tauri-drag-region lets users drag the frameless window from here */}
      <div
        data-tauri-drag-region
        className="w-[228px] flex-shrink-0 h-full flex items-center px-5 border-r border-gray-700 cursor-default"
      >
        <span className="text-[17px] font-bold tracking-tight select-none pointer-events-none">
          <span className="text-gray-100">sk</span>
          <span
            className="text-indigo-400"
            style={{ textShadow: '0 0 16px rgba(129,140,248,.5)' }}
          >AI</span>
          <span className="text-gray-100">ler</span>
        </span>
      </div>

      {/* Section divider + name */}
      <div className="w-px h-[55%] bg-gray-700 mx-4 flex-shrink-0" />
      <span className="text-[11px] tracking-[2px] uppercase text-gray-500 font-mono select-none">
        {SECTION[page]}
      </span>

      {/* Right pills */}
      <div className="ml-auto flex items-center h-full divide-x divide-gray-700">
        {/* Session clock */}
        <div className="flex items-center gap-2 px-4 h-full">
          <div
            className="w-[7px] h-[7px] rounded-full bg-indigo-500 flex-shrink-0"
            style={{ animation: 'pulseDot 2.4s ease-in-out infinite' }}
          />
          <span className="text-[11px] font-mono text-indigo-300">{elapsed}</span>
        </div>

        {/* Signal bars */}
        <div className="flex items-center gap-1.5 px-4 h-full">
          <span className="text-[11px] font-mono text-gray-500">SIG</span>
          <svg width="28" height="14" viewBox="0 0 28 14">
            <rect x="0"  y="8" width="4" height="6"  rx="1" fill="#818cf8" opacity=".8"/>
            <rect x="6"  y="5" width="4" height="9"  rx="1" fill="#818cf8" opacity=".8"/>
            <rect x="12" y="2" width="4" height="12" rx="1" fill="#818cf8" opacity=".8"/>
            <rect x="18" y="0" width="4" height="14" rx="1" fill="#818cf8" opacity=".8"/>
            <rect x="24" y="1" width="4" height="13" rx="1" fill="#1a2340"/>
          </svg>
        </div>

        {/* Status */}
        <div className="flex items-center gap-2 px-4 h-full">
          <div
            className="w-2 h-2 rounded-full bg-emerald-400 flex-shrink-0"
            style={{ boxShadow: '0 0 6px #34d399' }}
          />
          <span className="text-[11px] font-mono text-emerald-400">Nominal</span>
        </div>
      </div>
    </div>
  )
}
