import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { createTeam, db } from '@/db/db'
import AppBar from '../components/AppBar'
import Sheet from '../components/Sheet'

function currentSeason(): string {
  const d = new Date()
  const season = d.getMonth() >= 6 ? 'Fall' : 'Spring'
  return `${season} ${d.getFullYear()}`
}

export default function Teams() {
  const nav = useNavigate()
  const teams = useLiveQuery(() => db.teams.orderBy('createdAt').reverse().toArray(), [])
  const counts = useLiveQuery(async () => {
    const all = await db.players.toArray()
    const m: Record<string, number> = {}
    for (const p of all) if (p.active) m[p.teamId] = (m[p.teamId] ?? 0) + 1
    return m
  }, [])

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [season, setSeason] = useState(currentSeason())

  async function save() {
    const n = name.trim()
    if (!n) return
    const team = await createTeam(n, season)
    setAdding(false)
    setName('')
    nav(`/team/${team.id}`)
  }

  return (
    <>
      <AppBar
        title="Touchline"
        action={
          <button type="button" onClick={() => setAdding(true)} aria-label="New team">
            + Team
          </button>
        }
      />
      <main>
        {teams === undefined ? null : teams.length === 0 ? (
          <div className="empty">
            <strong>No teams yet</strong>
            Add a team, then build its roster.
            <div className="btn-row" style={{ marginTop: '1.2rem' }}>
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                Add your first team
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            {teams.map((t) => (
              <Link key={t.id} className="row" to={`/team/${t.id}`}>
                <span className="grow">
                  <span className="name">{t.name}</span>
                  <span className="meta">
                    {t.season} · {counts?.[t.id] ?? 0} players
                  </span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </Link>
            ))}
          </div>
        )}

        <div className="btn-row" style={{ marginTop: '1.4rem' }}>
          <Link className="btn" to="/backup">
            Backup &amp; restore
          </Link>
        </div>
      </main>

      {adding ? (
        <Sheet title="New team" onClose={() => setAdding(false)}>
          <label className="field">
            <span>Team name</span>
            <input
              type="text"
              value={name}
              autoFocus
              placeholder="Thunder U10"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save()
              }}
            />
          </label>
          <label className="field">
            <span>Season</span>
            <input
              type="text"
              value={season}
              onChange={(e) => setSeason(e.target.value)}
            />
          </label>
          <button type="button" className="btn primary wide" disabled={!name.trim()} onClick={() => void save()}>
            Create team
          </button>
        </Sheet>
      ) : null}
    </>
  )
}
