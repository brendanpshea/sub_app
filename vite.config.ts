import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  // Relative base so the same build works from the dev server, from `vite preview`,
  // and from a GitHub Pages project site at /<repo>/ — without hard-coding the repo
  // name anywhere. Routing is hash-based, so deep links survive the subpath too.
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Touchline',
        short_name: 'Touchline',
        description: 'Substitutions, playing time and stats for youth soccer.',
        theme_color: '#0e4a3a',
        background_color: '#0e4a3a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        // TODO: add 192/512 maskable PNGs before shipping to a phone home screen —
        // Android prefers raster icons for the launcher.
        icons: [
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { host: true },
})
