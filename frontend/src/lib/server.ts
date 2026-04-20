export interface ServerConfig {
  type: 'local' | 'remote'
  url:  string
}

export function getApi(): string {
  try {
    const raw = localStorage.getItem('skailer_server')
    if (raw) {
      const cfg = JSON.parse(raw) as ServerConfig
      return cfg.url.replace(/\/$/, '')
    }
  } catch { /* fall through to default */ }
  return 'http://localhost:8000'
}

export function saveServerConfig(cfg: ServerConfig): void {
  localStorage.setItem('skailer_server', JSON.stringify(cfg))
}

export const API = getApi()
