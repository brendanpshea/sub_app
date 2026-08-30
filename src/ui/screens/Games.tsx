import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { createGame } from '@/db/games'
import type { Game } from '@/domain/types'
import AppBar from '../components/AppBar'
import Sheet from '../components/Sheet'

function localDateValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function timeValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function describeKickoff(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * What to say about a fixture.
 *
 * Before it is played the scheduled time is all there is; afterwards the times
 * that matter are the ones the clock recorded, because a fixture rarely starts
 * when it was meant to.
 */
function describeGame(g: Game): string {
  if (g.status === 'final' && g.startedAt) {
    const played =
      g.endedAt && g.endedAt > g.startedAt
        ? ` · ${Math.round((g.endedAt - g.startedAt) / 60000)} min`
        : ''
    return `${describeKickoff(g.startedAt)}${played}`
  }
  return `${describeKickoff(g.kickoffAt)} · ${countIn(g)} available`
}

function countIn(g: Game): number {
  return g.attendance.filter((a) => a.status !== 'absent').length
}

export default function Games() {
  const { teamId = '' } = useParams()
  const nav = useNavigate()
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const games = useLiveQuery(
    () => db.games.where('teamId').equals(teamId).toArray(),
    [teamId],
  )

  const [adding, setAdding] = useState(false)
  const [opponent, setOpponent] = useState('')
  // Most games are entered as they are about to be played, so now is the
  // useful default; a fixture planned for next week is a change away.
  const [date, setDate] = useState(() => localDateValue(new Date()))
  const [time, setTime] = useState(() => timeValue(new Date()))
  const [homeAway, setHomeAway] = useState<Game['homeAway']>('home')

  async function save() {
    if (!team) return
    const kickoffAt = new Date(`${date}T${time}`).getTime()
    const g = await createGame(team, opponent, kickoffAt, homeAway)
    setAdding(false)
    setOpponent('')
    nav(`/team/${teamId}/game/${g.id}`)
  }

  const sorted = (games ?? []).slice().sort((a, b) => b.kickoffAt - a.kickoffAt)

  return (
    <>
      <AppBar
        title="Games"
        sub={team?.name}
        back={`/team/${teamId}`}
        action={
          <button type="button" onClick={() => setAdding(true)} aria-label="Add game">
            + Game
          </button>
        }
      />
      <main>
        {games === undefined ? null : sorted.length === 0 ? (
          <div className="empty">
            <strong>No games yet</strong>
            Add a fixture, mark who is coming, and the planner will build the shift
            chart.
            <div className="btn-row" style={{ marginTop: '1.2rem' }}>
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                Add your first game
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            {sorted.map((g) => (
              <Link
                key={g.id}
                className="row"
                // A game in progress goes straight to the pitch, and a
                // finished one to its summary. Neither should land on a setup
                // screen offering to start a match that is already over.
                to={`/team/${teamId}/game/${g.id}${
                  g.status === 'live' ? '/live' : g.status === 'final' ? '/recap' : ''
                }`}
              >
                <span className="grow">
                  <span className="name">
                    {g.homeAway === 'home' ? 'v' : 'at'} {g.opponent}
                  </span>
                  <span className="meta">{describeGame(g)}</span>
                </span>
                <span className={`pill ${g.status}`}>{g.status}</span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </Link>
            ))}
          </div>
        )}
      </main>

      {adding ? (
        <Sheet title="New game" onClose={() => setAdding(false)}>
          <label className="field">
            <span>Opponent</span>
            <input
              type="text"
              autoFocus
              value={opponent}
              placeholder="Ridgeview"
              onChange={(e) => setOpponent(e.target.value)}
            />
          </label>

          <div className="field">
            <div className="field-label">Where</div>
            <div className="chips">
              <button
                type="button"
                className="chipbtn"
                aria-pressed={homeAway === 'home'}
                onClick={() => setHomeAway('home')}
              >
                Home
              </button>
              <button
                type="button"
                className="chipbtn"
                aria-pressed={homeAway === 'away'}
                onClick={() => setHomeAway('away')}
              >
                Away
              </button>
            </div>
          </div>

          <label className="field">
            <span>Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            <span>Kick-off</span>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </label>

          <button type="button" className="btn primary wide" onClick={() => void save()}>
            Create game
          </button>
        </Sheet>
      ) : null}
    </>
  )
}
