import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { execSync } from 'node:child_process'

/**
 * Which build this is, shown on the home screen so a coach can tell whether
 * their phone has picked up the latest version. The commit comes from CI, or
 * from git locally.
 */
function buildVersion(): string {
  let sha = process.env.GITHUB_SHA ?? ''
  if (!sha) {
    try {
      sha = execSync('git rev-parse HEAD').toString().trim()
    } catch {
      sha = 'dev'
    }
  }
  return `${new Date().toISOString().slice(0, 10)} · ${sha.slice(0, 7)}`
}

export default defineConfig({
  // Relative base so the same build works from the dev server, from `vite preview`,
  // and from a GitHub Pages project site at /<repo>/ — without hard-coding the repo
  // name anywhere. Routing is hash-based, so deep links survive the subpath too.
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion()),
  },
  plugins: [
    react(),
    VitePWA({
      // A new version takes over as soon as it is downloaded. The page is
      // registered by hand in main.tsx, which decides when to reload onto it:
      // straight away, unless a game is on screen.
      registerType: 'autoUpdate',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'Touchline',
        short_name: 'Touchline',
        description: 'Substitutions, playing time and stats for youth soccer and basketball.',
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
