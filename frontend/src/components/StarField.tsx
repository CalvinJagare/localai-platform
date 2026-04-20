import { useEffect, useRef } from 'react'

export default function StarField() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const cvs = canvas
    const ctx = cvs.getContext('2d')!
    let animId: number

    type Star = { x: number; y: number; r: number; a: number; s: number }
    let stars: Star[] = []
    let w = 0, h = 0

    function init() {
      w = cvs.width  = window.innerWidth
      h = cvs.height = window.innerHeight
      stars = Array.from({ length: 180 }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.2 + 0.2,
        a: Math.random(),
        s: Math.random() * 0.002 + 0.001,
      }))
    }

    function draw() {
      ctx.clearRect(0, 0, w, h)
      for (const star of stars) {
        star.a += star.s
        if (star.a > 1 || star.a < 0) star.s *= -1
        ctx.beginPath()
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(165,180,252,${star.a * 0.55})`
        ctx.fill()
      }
      animId = requestAnimationFrame(draw)
    }

    init()
    draw()
    window.addEventListener('resize', init)
    return () => { cancelAnimationFrame(animId); window.removeEventListener('resize', init) }
  }, [])

  return <canvas ref={canvasRef} className="fixed inset-0 z-0 pointer-events-none" />
}
