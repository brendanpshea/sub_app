import { useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { downloadBackup, importBackup } from '@/db/backup'
import AppBar from '../components/AppBar'

export default function Backup() {
  const fileRef = useRef<HTMLInputElement>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const summary = useLiveQuery(async () => {
    const [teams, players, games, events] = await Promise.all([
      db.teams.count(),
      db.players.count(),
      db.games.count(),
      db.events.count(),
    ])
    return { teams, players, games, events }
  }, [])

  async function onFile(file: File) {
    setError(null)
    setMessage(null)
    try {
      const text = await file.text()
      const r = await importBackup(text)
      setMessage(
        `Restored ${r.teams} team${r.teams === 1 ? '' : 's'}, ${r.players} players and ${r.games} games.`,
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That file could not be read.')
    }
  }

  return (
    <>
      <AppBar title="Backup &amp; restore" back="/" />
      <main>
        <div className="card pad">
          <div className="dim">
            Everything lives on this device only — nothing is sent anywhere. That keeps
            it working on a field with no signal, but it also means a lost phone is a
            lost season. Export after each game.
          </div>
          {summary ? (
            <div className="dim" style={{ marginTop: '0.7rem' }}>
              Currently holding {summary.teams} teams, {summary.players} players,{' '}
              {summary.games} games and {summary.events} logged events.
            </div>
          ) : null}
        </div>

        {message ? (
          <div
            className="error"
            style={{ background: 'var(--brand-soft)', color: 'var(--brand-ink)' }}
          >
            {message}
          </div>
        ) : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="btn-row" style={{ marginTop: '1rem' }}>
          <button type="button" className="btn brand" onClick={() => void downloadBackup()}>
            Export backup
          </button>
        </div>
        <div className="btn-row">
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            Restore from file
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFile(f)
            e.target.value = ''
          }}
        />

        <div className="dim" style={{ marginTop: '1rem', padding: '0 0.2rem' }}>
          Restoring merges by record, so bringing a backup onto a second device adds
          what is missing rather than wiping what is already there.
        </div>
      </main>
    </>
  )
}
