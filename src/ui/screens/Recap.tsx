import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, rosterOf } from '@/db/db'
import { deleteGame, updateGame } from '@/db/games'
import { eventsOf, reopenGame } from '@/db/events'
import { reconcileAttendance } from '@/domain/attendance'
import { BUILT_IN_FORMATIONS, findFormation } from '@/domain/formations'
import { minutes, mmss, outfieldShareUpTo } from '@/domain/fairness'
import { deriveLive } from '@/domain/live'
import { goalIsOrdinaryPosition } from '@/domain/planner'
import type { Formation } from '@/domain/types'
import { displayName } from '@/domain/types'
import AppBar from '../components/AppBar'
import PlayingTime from '../components/PlayingTime'

function whenPlayed(g: { startedAt?: number; kickoffAt: number }): string {
  return new Date(g.startedAt ?? g.kickoffAt).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export default function Recap() {
  const { teamId = '', gameId = '' } = useParams()
  const nav = useNavigate()

  const game = useLiveQuery(() => db.games.get(gameId), [gameId])
  const roster = useLiveQuery(() => rosterOf(teamId), [teamId])
  const custom = useLiveQuery(
    () => db.formations.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  const events = useLiveQuery(() => eventsOf(gameId), [gameId])

  const formation: Formation =
    findFormation(custom, game?.formationId ?? '') ?? BUILT_IN_FORMATIONS[0]!

  const attendance = useMemo(
    () => (game && roster ? reconcileAttendance(game.attendance, roster) : []),
    [game, roster],
  )

  // Frozen at the final whistle: a finished game has no clock still running,
  // so "now" can be anything at all.
  const s = useMemo(
    () =>
      game ? deriveLive(events ?? [], game.rules, formation, game.endedAt ?? Date.now()) : null,
    [game, events, formation],
  )

  if (!game || !roster || !s) return <AppBar title="Full time" back={`/team/${teamId}/games`} />

  const available = roster.filter((p) =>
    attendance.some((a) => a.playerId === p.id && a.status !== 'absent'),
  )
  const goalOrdinary = goalIsOrdinaryPosition(game.rules)
  const share = outfieldShareUpTo(
    game.rules,
    attendance,
    goalOrdinary ? [] : s.keeperSpans,
    goalOrdinary
      ? formation.slots.length
      : formation.slots.filter((sl) => sl.requiredRole !== 'GK').length,
    s.cumulativeSec,
  )

  const goals = s.live.filter((e) => e.body.type === 'GOAL')
  const savers = [...s.saves.entries()].sort((a, b) => b[1] - a[1])
  const show = (id: string): string => {
    const p = roster.find((x) => x.id === id)
    return p ? displayName(p, available) : '?'
  }

  async function reopen() {
    if (
      !confirm(
        'Reopen this game?\n\nThe clock goes back to where it was when you ended it, paused. Tap play when you are ready.',
      )
    ) {
      return
    }
    await reopenGame(gameId)
    await updateGame(gameId, { status: 'live', endedAt: undefined })
    nav(`/team/${teamId}/game/${gameId}/live`)
  }

  /**
   * A played game holds the only record of who played how long, so this asks
   * in terms of what it destroys rather than which row is disappearing.
   */
  async function remove() {
    const parts = [`${minutes(s!.cumulativeSec)} of playing time`]
    if (s!.goalCount > 0) {
      parts.push(`${s!.goalCount} ${s!.goalCount === 1 ? 'goal' : 'goals'}`)
    }
    const warn = [
      `Delete the game against ${game!.opponent}?`,
      '',
      `This permanently removes ${parts.join(' and ')}. It cannot be undone.`,
    ].join('\n')
    if (!confirm(warn)) return
    await deleteGame(gameId)
    nav(`/team/${teamId}/games`, { replace: true })
  }

  return (
    <>
      <AppBar
        title="Full time"
        sub={`${game.homeAway === 'home' ? 'v' : 'at'} ${game.opponent}`}
        back={`/team/${teamId}/games`}
      />
      <main>
        <div className="summary">
          <span className="big">{s.goalCount}</span>
          <span className="cap">
            {s.goalCount === 1 ? 'goal' : 'goals'} · {minutes(s.cumulativeSec)} played ·{' '}
            {whenPlayed(game)}
          </span>
        </div>

        <div className="section-label">Playing time</div>
        <PlayingTime
          state={s}
          roster={available}
          share={share}
          goalIsOrdinary={goalOrdinary}
        />
        <div className="dim" style={{ marginTop: '0.5rem', padding: '0 0.2rem' }}>
          {goalOrdinary
            ? 'Total minutes. The goal rotates like any other position.'
            : 'Field minutes, with time in goal shown separately. The team shares out field time; goal duty is rotated on its own.'}
        </div>

        {goals.length > 0 ? (
          <>
            <div className="section-label">Goals</div>
            <div className="card">
              {goals.map((e) => {
                const body = e.body as { type: 'GOAL'; playerId?: string; assistId?: string }
                return (
                  <div className="final-line" key={e.id}>
                    <span>
                      {body.playerId ? show(body.playerId) : 'Unknown'}
                      {body.assistId ? (
                        <span className="dim"> · assist {show(body.assistId)}</span>
                      ) : null}
                    </span>
                    <b className="tnum">{mmss(s.timeOf.get(e.id) ?? 0)}</b>
                  </div>
                )
              })}
            </div>
          </>
        ) : null}

        {savers.length > 0 ? (
          <>
            <div className="section-label">Saves</div>
            <div className="card">
              {savers.map(([id, n]) => (
                <div className="final-line" key={id}>
                  <span>{show(id)}</span>
                  <b>{n}</b>
                </div>
              ))}
            </div>
          </>
        ) : null}

        {game.status === 'final' ? (
          <div className="btn-row" style={{ marginTop: '1.6rem' }}>
            <button type="button" className="btn" onClick={() => void reopen()}>
              Reopen game
            </button>
          </div>
        ) : null}

        <div className="btn-row" style={{ marginTop: '0.6rem' }}>
          <button type="button" className="btn danger" onClick={() => void remove()}>
            Delete game
          </button>
        </div>
      </main>
    </>
  )
}
