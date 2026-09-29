import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': process.env.TNEGA_API ?? 'http://127.0.0.1:3080',
    },
  },
})
