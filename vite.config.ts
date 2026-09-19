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
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
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
        // Android's launcher and Chrome's install prompt want raster icons.
        // Regenerate with scripts/make-icons.py if the drawing changes.
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
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
