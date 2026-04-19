import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Tauri: let the Tauri CLI own the terminal output
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,  // fail fast — Tauri expects exactly port 1420
    host: 'localhost',
  },

  envPrefix: ['VITE_', 'TAURI_ENV_'],
})
