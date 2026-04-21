import StarField from './StarField'

async function winAction(action: 'minimize' | 'close') {
  const { getCurrentWindow } = await import('@tauri-apps/api/window')
  const win = getCurrentWindow()
  if (action === 'minimize') win.minimize()
  else win.close()
}

interface Props {
  statusText: string
}

export default function SplashScreen({ statusText }: Props) {
  return (
    <div className="fixed inset-0 bg-gray-950 select-none flex flex-col">
      <StarField />

      {/* Title bar — drag region, matches TopBar height/style */}
      <div
        data-tauri-drag-region
        className="relative z-10 h-12 flex-shrink-0 flex items-center px-5 border-b border-gray-800 bg-gray-900"
      >
        <span className="text-[17px] font-bold tracking-tight pointer-events-none">
          <span className="text-white">sk</span>
          <span className="text-indigo-400" style={{ textShadow: '0 0 16px rgba(129,140,248,.5)' }}>AI</span>
          <span className="text-white">ler</span>
        </span>

        <div className="ml-auto flex items-center h-full -mr-5">
          {([
            { action: 'minimize', label: '─', hover: 'hover:bg-gray-700' },
            { action: 'close',    label: '✕', hover: 'hover:bg-red-600'  },
          ] as const).map(({ action, label, hover }) => (
            <button
              key={action}
              onClick={() => winAction(action)}
              className={`w-12 h-full flex items-center justify-center text-gray-500 hover:text-gray-100 ${hover} transition-colors text-[13px]`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative z-10 flex flex-col items-center justify-center flex-1 gap-0">
        {/* Astronaut SVG */}
        <svg
          className="ast-float mb-8"
          width="72" height="100"
          viewBox="0 0 100 140"
          xmlns="http://www.w3.org/2000/svg"
          style={{ filter: 'drop-shadow(0 0 18px rgba(99,102,241,.4))' }}
        >
          <ellipse cx="50" cy="36" rx="24" ry="26" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <ellipse cx="50" cy="38" rx="15" ry="13" fill="rgba(99,102,241,0.07)" stroke="#a5b4fc" strokeWidth="1" opacity=".8"/>
          <ellipse cx="44" cy="33" rx="5" ry="3.5" fill="rgba(165,180,252,0.18)"/>
          <rect x="26" y="58" width="48" height="46" rx="10" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <rect x="34" y="65" width="32" height="20" rx="4" fill="rgba(99,102,241,0.08)" stroke="#6366f1" strokeWidth="0.8" opacity=".6"/>
          <rect x="37" y="68" width="6" height="5" rx="1.5" fill="#34d399" opacity=".6"/>
          <rect x="45" y="68" width="5" height="5" rx="1.5" fill="#818cf8" opacity=".5"/>
          <rect x="52" y="68" width="5" height="5" rx="1.5" fill="#fbbf24" opacity=".45"/>
          <rect x="42" y="58" width="16" height="6" rx="3" fill="#141d35" stroke="#6366f1" strokeWidth="1"/>
          <rect x="10" y="60" width="18" height="34" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <ellipse cx="19" cy="95" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
          <rect x="72" y="60" width="18" height="34" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <ellipse cx="81" cy="95" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
          <rect x="30" y="102" width="16" height="28" rx="7" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <rect x="54" y="102" width="16" height="28" rx="7" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
          <ellipse cx="38" cy="130" rx="12" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
          <ellipse cx="62" cy="130" rx="12" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
          <line x1="50" y1="10" x2="50" y2="2" stroke="#a5b4fc" strokeWidth="1.5"/>
          <circle cx="50" cy="2" r="2.5" fill="#818cf8" opacity=".9"/>
        </svg>

        {/* Brand */}
        <div className="text-center mb-10">
          <div className="text-[32px] font-bold tracking-tight leading-none mb-1 text-white">
            sk<span style={{ color: '#818cf8', textShadow: '0 0 18px rgba(129,132,248,.6)' }}>AI</span>ler
          </div>
          <div className="text-[11px] tracking-[3px] uppercase font-mono" style={{ color: '#4a5580' }}>
            Your AI at your fingertips
          </div>
        </div>

        {/* Spinner */}
        <div className="relative w-10 h-10 mb-6">
          <div
            className="absolute inset-0 rounded-full border animate-ping"
            style={{ borderColor: 'rgba(99,102,241,.2)' }}
          />
          <div
            className="absolute inset-0 rounded-full border-2 border-transparent animate-spin"
            style={{ borderTopColor: '#6366f1' }}
          />
        </div>

        {/* Status text */}
        <p
          className="text-[12px] font-mono min-h-[1.25rem] text-center transition-all duration-300"
          style={{ color: '#4a5580' }}
        >
          {statusText}
        </p>
      </div>
    </div>
  )
}
