import { useEffect, useRef, useState } from 'react'

export type AstronautMode = 'idle' | 'training' | 'success' | 'error' | 'wave' | 'bounce' | 'spin'

interface Props {
  mode?: AstronautMode
}

const QUIPS = [
  "Been floating here for hours. Hours.",
  "I can see 14 galaxies from here. Pretty neat.",
  "Training job running. Watching closely.",
  "Space is mostly empty. Like my inbox after skAIler.",
  "Click me again and I'll do a spin. Fair warning.",
  "I've named all the stars. There's Kevin. And Dave.",
  "Nominal. Everything nominal. Suspiciously nominal.",
  "Best part of this job — zero gravity.",
  "The void is peaceful. Also slightly terrifying. Both.",
  "One small click for you, one giant wiggle for me.",
  "Four signal bars up here. Better than my apartment.",
  "My helmet is fogging up. Someone's nervous.",
]

const CLICK_ANIMS: AstronautMode[] = ['wave', 'bounce', 'spin', 'wave', 'bounce']

const ANIM_CLASS: Record<AstronautMode, string> = {
  idle:     'ast-float',
  training: 'ast-lean',
  success:  'ast-celebrate',
  error:    'ast-scratch',
  wave:     'ast-wave',
  bounce:   'ast-bounce',
  spin:     'ast-spin',
}

export default function Astronaut({ mode = 'idle' }: Props) {
  const [displayMode, setDisplayMode] = useState<AstronautMode>(mode)
  const [bubble, setBubble]           = useState<string | null>(null)
  const [clickCount, setClickCount]   = useState(0)
  const quipIdxRef    = useRef(Math.floor(Math.random() * QUIPS.length))
  const parentModeRef = useRef(mode)
  const bubbleTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    parentModeRef.current = mode
    setDisplayMode(mode)
  }, [mode])

  // Random idle quip every 45 s
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) showBubble(QUIPS[quipIdxRef.current++ % QUIPS.length])
    }, 45_000)
    return () => clearInterval(id)
  }, [])

  function showBubble(text: string) {
    setBubble(text)
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    bubbleTimer.current = setTimeout(() => setBubble(null), 3200)
  }

  function handleClick() {
    const next = clickCount + 1
    setClickCount(next)
    const anim = CLICK_ANIMS[next % CLICK_ANIMS.length]
    setDisplayMode(anim)
    showBubble(QUIPS[quipIdxRef.current++ % QUIPS.length])
    setTimeout(() => setDisplayMode(parentModeRef.current), 800)
  }

  return (
    <div className="flex flex-col items-center gap-2 px-4 pb-2 relative">
      {/* Speech bubble */}
      {bubble && (
        <div
          className="absolute bottom-full mb-1 left-1/2 -translate-x-1/2 z-50
            px-3 py-2 rounded-lg text-[11px] text-gray-200 leading-relaxed text-center
            max-w-[190px] whitespace-normal border"
          style={{
            background: '#141d35',
            borderColor: 'rgba(99,102,241,0.55)',
            boxShadow: '0 0 14px rgba(99,102,241,.18)',
          }}
        >
          {bubble}
          {/* Tail */}
          <span
            className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0"
            style={{
              borderLeft: '6px solid transparent',
              borderRight: '6px solid transparent',
              borderTop: '6px solid rgba(99,102,241,0.55)',
            }}
          />
        </div>
      )}

      <svg
        className={`w-20 cursor-pointer transition-[filter] duration-200 ${ANIM_CLASS[displayMode]}`}
        style={{ filter: 'drop-shadow(0 0 14px rgba(99,102,241,.3))' }}
        onMouseEnter={e => (e.currentTarget.style.filter = 'drop-shadow(0 0 22px rgba(99,102,241,.55))')}
        onMouseLeave={e => (e.currentTarget.style.filter = 'drop-shadow(0 0 14px rgba(99,102,241,.3))')}
        viewBox="0 0 100 140"
        xmlns="http://www.w3.org/2000/svg"
        onClick={handleClick}
        aria-label="Click me!"
      >
        {/* helmet */}
        <ellipse cx="50" cy="36" rx="24" ry="26" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
        {/* visor */}
        <ellipse cx="50" cy="38" rx="15" ry="13" fill="rgba(99,102,241,0.07)" stroke="#a5b4fc" strokeWidth="1" opacity=".8"/>
        <ellipse cx="44" cy="33" rx="5" ry="3.5" fill="rgba(165,180,252,0.18)"/>
        {/* body */}
        <rect x="26" y="58" width="48" height="46" rx="10" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
        {/* chest display */}
        <rect x="34" y="65" width="32" height="20" rx="4" fill="rgba(99,102,241,0.08)" stroke="#6366f1" strokeWidth="0.8" opacity=".6"/>
        <rect x="37" y="68" width="6" height="5" rx="1.5" fill="#34d399" opacity=".6"/>
        <rect x="45" y="68" width="5" height="5" rx="1.5" fill="#818cf8" opacity=".5"/>
        <rect x="52" y="68" width="5" height="5" rx="1.5" fill="#fbbf24" opacity=".45"/>
        <line x1="36" y1="78" x2="64" y2="78" stroke="#1a2340" strokeWidth="1"/>
        <line x1="36" y1="82" x2="58" y2="82" stroke="#1a2340" strokeWidth="0.8"/>
        {/* neck */}
        <rect x="42" y="58" width="16" height="6" rx="3" fill="#141d35" stroke="#6366f1" strokeWidth="1"/>
        {/* arms */}
        <rect x="10" y="60" width="18" height="34" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
        <ellipse cx="19" cy="95" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
        <rect x="72" y="60" width="18" height="34" rx="9" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
        <ellipse cx="81" cy="95" rx="9" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
        {/* legs */}
        <rect x="30" y="102" width="16" height="28" rx="7" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
        <rect x="54" y="102" width="16" height="28" rx="7" fill="#141d35" stroke="#6366f1" strokeWidth="1.5"/>
        {/* boots */}
        <ellipse cx="38" cy="130" rx="12" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
        <ellipse cx="62" cy="130" rx="12" ry="7" fill="#1a2442" stroke="#a5b4fc" strokeWidth="1"/>
        {/* antenna */}
        <line x1="50" y1="10" x2="50" y2="2" stroke="#a5b4fc" strokeWidth="1.5"/>
        <circle cx="50" cy="2" r="2.5" fill="#818cf8" opacity=".9"/>
        {/* backpack */}
        <rect x="72" y="64" width="10" height="20" rx="3" fill="#1a2442" stroke="#1a2340" strokeWidth="1"/>
      </svg>

      <span className="text-[10px] text-gray-500 font-mono tracking-wider">Mission Control</span>
    </div>
  )
}
