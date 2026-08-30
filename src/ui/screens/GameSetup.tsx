import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, rosterOf } from '@/db/db'
import {
  arrivalMarks,
  deleteGame,
  departureMarks,
  reconcileAttendance,
  setAllAttendance,
  setAttendance,
  updateGame,
  updateRules,
} from '@/db/games'
import { BUILT_IN_FORMATIONS, findFormation } from '@/domain/formations'
import { fairShareSec, minutes } from '@/domain/fairness'
import type { Attendance, AttendanceStatus, Player } from '@/domain/types'
import { fullName, gameLengthSec } from '@/domain/types'
import AppBar from '../components/AppBar'
import Pitch from '../components/Pitch'
import MatchRules from '../components/MatchRules'
import Sheet from '../components/Sheet'

const SEG: { status: AttendanceStatus; label: string; tone?: string }[] = [
  { status: 'available', label: 'Here' },
  { status: 'late', label: 'Late', tone: 'warn' },
  { status: 'leaveEarly', label: 'Early', tone: 'warn' },
  { status: 'absent', label: 'Out', tone: 'out' },
]

export default function GameSetup() {
  const { teamId = '', gameId = '' } = useParams()
  const nav = useNavigate()

  const game = useLiveQuery(() => db.games.get(gameId), [gameId])
  const roster = useLiveQuery(
    () => rosterOf(teamId),
    [teamId],
  )
  const custom = useLiveQuery(
    () => db.formations.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  const [pickingFormation, setPickingFormation] = useState(false)

  const attendance: Attendance[] = useMemo(
    () => (game && roster ? reconcileAttendance(game.attendance, roster) : []),
    [game, roster],
  )

  const share = useMemo(
    () => (game ? fairShareSec(game.rules, attendance) : new Map<string, number>()),
    [game, attendance],
  )

  if (!game || !roster) return <AppBar title="Game" back={`/team/${teamId}/games`} />

  const formation =
    findFormation(custom, game.formationId) ?? BUILT_IN_FORMATIONS[0]!
  const byId = new Map(roster.map((p) => [p.id, p]))
  const inCount = attendance.filter((a) => a.status !== 'absent').length
  const shortHanded = inCount > 0 && inCount < game.rules.playersOnField
  const typical = inCount > 0 ? (game.rules.playersOnField * gameLengthSec(game.rules)) / inCount : 0

  async function remove() {
    if (!confirm(`Delete this game against ${game!.opponent}?`)) return
    await deleteGame(gameId)
    nav(`/team/${teamId}/games`, { replace: true })
  }

  return (
    <>
      <AppBar
        title={`${game.homeAway === 'home' ? 'v' : 'at'} ${game.opponent}`}
        sub={new Date(game.kickoffAt).toLocaleString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })}
        back={`/team/${teamId}/games`}
      />
      <main>
        <div className={`summary${shortHanded ? ' warn' : ''}`}>
          <span className="big">{inCount}</span>
          <span className="cap">
            {inCount === 1 ? 'player available' : 'players available'}
            {inCount === 0 ? null : shortHanded ? (
              <>
                {' '}
                — short of {game.rules.playersOnField}. Everyone plays the whole game.
              </>
            ) : (
              <> · about {minutes(typical)} each</>
            )}
          </span>
        </div>

        <div className="section-label">
          Who is here
          <button
            type="button"
            onClick={() => void setAllAttendance(gameId, 'available')}
            style={{
              float: 'right',
              background: 'none',
              border: 0,
              color: 'var(--brand-ink)',
              font: 'inherit',
              fontSize: '0.72rem',
              fontWeight: 700,
              letterSpacing: '0.06em',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ALL HERE
          </button>
        </div>

        <div className="card">
          {attendance.length === 0 ? (
            <div className="pad dim">
              No active players on the roster yet. Add some first.
            </div>
          ) : (
            attendance.map((a) => (
              <AttendanceRow
                key={a.playerId}
                gameId={gameId}
                att={a}
                player={byId.get(a.playerId)}
                targetSec={share.get(a.playerId) ?? 0}
                arrivals={arrivalMarks(game.rules)}
                departures={departureMarks(game.rules)}
              />
            ))
          )}
        </div>

        <div className="section-label">Shape</div>
        <button
          type="button"
          className="card pad"
          onClick={() => setPickingFormation(true)}
          style={{
            display: 'flex',
            gap: '0.9rem',
            alignItems: 'center',
            width: '100%',
            textAlign: 'left',
            font: 'inherit',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <span style={{ width: 72, flex: '0 0 auto' }}>
            <Pitch formation={formation} />
          </span>
          <span style={{ flex: 1 }}>
            <span style={{ display: 'block', fontSize: '1.25rem', fontWeight: 700 }}>
              {formation.name}
            </span>
            <span className="dim">Tap to change for this game only</span>
          </span>
          <span className="chev" aria-hidden="true">
            ›
          </span>
        </button>

        <div className="section-label">Match rules — this game only</div>
        <MatchRules rules={game.rules} onChange={(p) => void updateRules(gameId, p)} />

        <div className="btn-row" style={{ marginTop: '1.4rem' }}>
          <button
            type="button"
            className="btn"
            disabled={inCount < game.rules.playersOnField}
            onClick={() => nav(`/team/${teamId}/game/${gameId}/plan`)}
          >
            {inCount < game.rules.playersOnField
              ? `Need ${game.rules.playersOnField - inCount} more`
              : 'Shift chart'}
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={inCount < game.rules.playersOnField}
            onClick={() => nav(`/team/${teamId}/game/${gameId}/live`)}
          >
            {game.status === 'live' ? 'Back to the game' : 'Match day'}
          </button>
        </div>

        <div className="btn-row" style={{ marginTop: '1.6rem' }}>
          <button type="button" className="btn danger" onClick={() => void remove()}>
            Delete game
          </button>
        </div>
      </main>

      {pickingFormation ? (
        <Sheet title="Shape for this game" onClose={() => setPickingFormation(false)}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
              gap: '0.6rem',
            }}
          >
            {BUILT_IN_FORMATIONS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="card"
                aria-pressed={f.id === game.formationId}
                onClick={() => {
                  void updateGame(gameId, {
                    formationId: f.id,
                    rules: { ...game.rules, playersOnField: f.playersOnField },
                  })
                  setPickingFormation(false)
                }}
                style={{
                  padding: '0.5rem',
                  cursor: 'pointer',
                  font: 'inherit',
                  color: 'inherit',
                  borderColor: f.id === game.formationId ? 'var(--accent)' : 'var(--rule)',
                  borderWidth: f.id === game.formationId ? 2 : 1,
                }}
              >
                <Pitch formation={f} />
                <div style={{ marginTop: '0.4rem', fontWeight: 700 }}>{f.name}</div>
              </button>
            ))}
          </div>
        </Sheet>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------- rows

interface RowProps {
  gameId: string
  att: Attendance
  player: Player | undefined
  targetSec: number
  arrivals: { label: string; sec: number }[]
  departures: { label: string; sec: number }[]
}

function AttendanceRow({
  gameId,
  att,
  player,
  targetSec,
  arrivals,
  departures,
}: RowProps) {
  const out = att.status === 'absent'

  function pick(status: AttendanceStatus) {
    if (status === 'late') {
      const first = arrivals[0]
      void setAttendance(gameId, att.playerId, {
        status,
        availableFromSec: att.availableFromSec ?? first?.sec ?? 0,
        availableUntilSec: undefined,
      })
    } else if (status === 'leaveEarly') {
      const last = departures[departures.length - 1]
      void setAttendance(gameId, att.playerId, {
        status,
        availableUntilSec: att.availableUntilSec ?? last?.sec ?? 0,
        availableFromSec: undefined,
      })
    } else {
      void setAttendance(gameId, att.playerId, {
        status,
        availableFromSec: undefined,
        availableUntilSec: undefined,
      })
    }
  }

  return (
    <div className={`att${out ? ' out' : ''}`}>
      <div className="att-head">
        <span className="name">{player ? fullName(player) : 'Unknown player'}</span>
        <span className="target">{out ? '—' : minutes(targetSec)}</span>
      </div>

      <div className="seg">
        {SEG.map((s) => (
          <button
            key={s.status}
            type="button"
            data-tone={s.tone}
            aria-pressed={att.status === s.status}
            onClick={() => pick(s.status)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {att.status === 'late' && arrivals.length > 0 ? (
        <div className="marks">
          <span className="lead">Arrives</span>
          {arrivals.map((m) => (
            <button
              key={m.sec}
              type="button"
              aria-pressed={att.availableFromSec === m.sec}
              onClick={() =>
                void setAttendance(gameId, att.playerId, {
                  status: 'late',
                  availableFromSec: m.sec,
                })
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : null}

      {att.status === 'leaveEarly' && departures.length > 0 ? (
        <div className="marks">
          <span className="lead">Leaves after</span>
          {departures.map((m) => (
            <button
              key={m.sec}
              type="button"
              aria-pressed={att.availableUntilSec === m.sec}
              onClick={() =>
                void setAttendance(gameId, att.playerId, {
                  status: 'leaveEarly',
                  availableUntilSec: m.sec,
                })
              }
            >
              {m.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
