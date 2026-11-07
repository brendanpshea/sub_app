import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles.css'

/**
 * Keep the installed app current.
 *
 * A phone that installed the app holds on to the copy it has: it can resume a
 * home-screen app from memory for days without loading anything, so a fix
 * shipped on Tuesday may not reach Saturday's game. So the app asks for a new
 * version whenever it comes back to the foreground, and once an hour while
 * open. A new version takes over as soon as it has downloaded, and the page
 * reloads onto it.
 *
 * Never mid-game, though: a reload is safe — everything lives on the device
 * and the clock is worked out from timestamps — but it would close whatever
 * the coach had open. An update that arrives during a game waits until they
 * leave the match screen.
 */
function keepCurrent(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
  const onMatchScreen = (): boolean => /\/live(\b|$)/.test(window.location.hash)
  // Only a change of version, not the very first install, warrants a reload.
  const hadController = !!navigator.serviceWorker.controller
  let pending = false
  const reloadWhenFree = (): void => {
    pending = true
    if (!onMatchScreen()) window.location.reload()
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadWhenFree()
  })
  window.addEventListener('hashchange', () => {
    if (pending && !onMatchScreen()) window.location.reload()
  })
  navigator.serviceWorker
    .register('./sw.js', { scope: './' })
    .then((reg) => {
      const check = () => void reg.update().catch(() => {})
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.setInterval(check, 60 * 60 * 1000)
    })
    .catch(() => {})
}
keepCurrent()

// Hash routing so the app deploys to any static host — including GitHub Pages —
// without server-side SPA fallback.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
)
