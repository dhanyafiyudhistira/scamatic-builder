import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // Forward /api/* from Vite dev server → Express backend
      '/api': {
        target:       'http://localhost:3001',
        changeOrigin: true
      },
      // Isaac is an opt-in Axum WebSocket canary on a loopback-only port.
      '/isaac-stream': {
        target:       'ws://127.0.0.1:3003',
        ws:           true,
        changeOrigin: false
      }
    }
  }
})
