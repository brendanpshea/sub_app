import { Link, useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, deleteTeam } from '@/db/db'
import { BUILT_IN_FORMATIONS, findFormation } from '@/domain/formations'
import { gameLengthSec } from '@/domain/types'
import AppBar from '../components/AppBar'
import Pitch from '../components/Pitch'

export default function TeamDetail() {
  const { teamId = '' } = useParams()
  const nav = useNavigate()

  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const players = useLiveQuery(
    () => db.players.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  const custom = useLiveQuery(
    () => db.formations.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  const games = useLiveQuery(
    () => db.games.where('teamId').equals(teamId).toArray(),
    [teamId],
  )

  if (team === undefined) return <AppBar title="Team" back="/" />
  if (team === null || !team) {
    return (
      <>
        <AppBar title="Team" back="/" />
        <main>
          <div className="empty">
            <strong>Team not found</strong>
            It may have been deleted.
          </div>
        </main>
      </>
    )
  }

  const formation =
    findFormation(custom, team.defaultFormationId) ?? BUILT_IN_FORMATIONS[0]!
  const now = Date.now()
  const nextGame = (games ?? [])
    .filter((g) => g.status !== 'final' && g.kickoffAt >= now - 3 * 60 * 60 * 1000)
    .sort((a, b) => a.kickoffAt - b.kickoffAt)[0]

  const active = (players ?? []).filter((p) => p.active)
  const keepers = active.filter((p) => p.gk !== 'never')
  const minutesEach =
    active.length > 0
      ? Math.round(
          (team.rules.playersOnField * gameLengthSec(team.rules)) / active.length / 60,
        )
      : 0

  async function removeTeam() {
    if (!confirm(`Delete ${team!.name} and all of its games? This cannot be undone.`)) return
    await deleteTeam(teamId)
    nav('/', { replace: true })
  }

  return (
    <>
      <AppBar title={team.name} sub={team.season} back="/" />
      <main>
        <div className="card pad">
          <div style={{ display: 'flex', gap: '0.9rem', alignItems: 'center' }}>
            <div style={{ width: 96, flex: '0 0 auto' }}>
              <Pitch formation={formation} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '1.35rem', fontWeight: 700 }}>{formation.name}</div>
              <div className="dim">
                {team.rules.playersOnField}v{team.rules.playersOnField} ·{' '}
                {team.rules.periodCount} × {team.rules.periodMinutes} min
              </div>
              <div className="dim" style={{ marginTop: '0.4rem' }}>
                {active.length} available ·{' '}
                {active.length >= team.rules.playersOnField ? (
                  <>~{minutesEach} min each</>
                ) : (
                  <span style={{ color: 'var(--warn)' }}>short-handed</span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="section-label">Setup</div>
        <div className="card">
          <Link className="row" to={`/team/${teamId}/roster`}>
            <span className="grow">
              <span className="name">Roster</span>
              <span className="meta">
                {active.length} active
                {keepers.length > 0 ? ` · ${keepers.length} will play in goal` : ''}
              </span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
          <Link className="row" to={`/team/${teamId}/formation`}>
            <span className="grow">
              <span className="name">Formation</span>
              <span className="meta">{formation.name}</span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </div>

        <div className="section-label">Games</div>
        <div className="card">
          <Link className="row" to={`/team/${teamId}/games`}>
            <span className="grow">
              <span className="name">Games</span>
              <span className="meta">
                {games === undefined
                  ? ' '
                  : games.length === 0
                    ? 'No fixtures yet'
                    : nextGame
                      ? `Next: ${nextGame.homeAway === 'home' ? 'v' : 'at'} ${nextGame.opponent}`
                      : `${games.length} played`}
              </span>
            </span>
            <span className="chev" aria-hidden="true">
              ›
            </span>
          </Link>
        </div>

        <div className="btn-row" style={{ marginTop: '1.6rem' }}>
          <button type="button" className="btn danger" onClick={() => void removeTeam()}>
            Delete team
          </button>
        </div>
      </main>
    </>
  )
}
