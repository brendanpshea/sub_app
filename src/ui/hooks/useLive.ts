import { useEffect, useState } from 'react'

/**
 * A ticking value used only to force a re-render. The clock itself is derived
 * from wall-clock timestamps in the event log, so a missed tick costs nothing
 * and a backgrounded tab catches up the moment it comes back.
 */
export function useNow(active: boolean, intervalMs = 500): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), intervalMs)
    const onVisible = () => {
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [active, intervalMs])

  return now
}

interface Releasable {
  release: () => Promise<void>
}

/**
 * Hold the screen awake while a game is running, and take it again after the
 * phone has been locked — the browser drops the lock on every visibility
 * change, so re-requesting is not optional.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const nav = navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<Releasable> }
    }
    if (!nav.wakeLock) return

    let sentinel: Releasable | null = null
    let disposed = false

    const acquire = async () => {
      if (disposed || document.visibilityState !== 'visible') return
      try {
        sentinel = (await nav.wakeLock!.request('screen')) ?? null
      } catch {
        // Denied, unsupported, or the tab lost focus mid-request. Not fatal —
        // the coach's screen may simply dim.
      }
    }

    void acquire()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release().catch(() => undefined)
    }
  }, [active])
}
