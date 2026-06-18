import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Forward /api/* from Vite dev server → Express backend
      '/api': {
        target:       'http://localhost:3001',
        changeOrigin: true
      }
    }
  }
})
