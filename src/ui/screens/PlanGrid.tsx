import { useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, rosterOf } from '@/db/db'
import { updateRules } from '@/db/games'
import { isPinned, loadPlan, savePlan, togglePin } from '@/db/plans'
import { reconcileAttendance } from '@/domain/attendance'
import { BUILT_IN_FORMATIONS, findFormation } from '@/domain/formations'
import {
  availabilityWindows,
  buildShiftGrid,
  eligibleDuring,
  minutes,
  signedMmss,
} from '@/domain/fairness'
import { generatePlan } from '@/domain/planner'
import type { Formation, Pin, PlannedShift, Player, SlotId } from '@/domain/types'
import { displayName, fullName, nameSortKey } from '@/domain/types'
import AppBar from '../components/AppBar'
import Sheet from '../components/Sheet'

interface CellTarget {
  shiftIndex: number
  slotId: SlotId
}

export default function PlanGrid() {
  const { teamId = '', gameId = '' } = useParams()

  const game = useLiveQuery(() => db.games.get(gameId), [gameId])
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const roster = useLiveQuery(
    () => rosterOf(teamId),
    [teamId],
  )
  const pairings = useLiveQuery(
    () => db.pairings.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  const custom = useLiveQuery(
    () => db.formations.where('teamId').equals(teamId).toArray(),
    [teamId],
  )
  const plan = useLiveQuery(() => loadPlan(gameId), [gameId])

  const [cell, setCell] = useState<CellTarget | null>(null)
  const [busy, setBusy] = useState(false)

  const formation: Formation =
    findFormation(custom, game?.formationId ?? '') ?? BUILT_IN_FORMATIONS[0]!

  const attendance = useMemo(
    () => (game && roster ? reconcileAttendance(game.attendance, roster) : []),
    [game, roster],
  )

  const available = useMemo(() => {
    const ok = new Set(
      attendance.filter((a) => a.status !== 'absent').map((a) => a.playerId),
    )
    return (roster ?? []).filter((p) => ok.has(p.id))
  }, [attendance, roster])

  const grid = useMemo(() => (game ? buildShiftGrid(game.rules) : []), [game])
  const windows = useMemo(
    () => (game ? availabilityWindows(game.rules, attendance) : []),
    [game, attendance],
  )

  // Totals are recomputed from whatever is on screen, including hand edits.
  const totals = useMemo(() => {
    const out = new Map<string, number>()
    if (!plan) return out
    for (let i = 0; i < plan.shifts.length; i++) {
      const slice = grid[i]
      const shift = plan.shifts[i]
      if (!slice || !shift) continue
      const d = slice.endSec - slice.startSec
      for (const slot of formation.slots) {
        const pid = shift.assignments[slot.id]
        if (pid) out.set(pid, (out.get(pid) ?? 0) + d)
      }
    }
    return out
  }, [plan, grid, formation])

  const targets = useMemo(() => {
    if (!game || available.length === 0) return new Map<string, number>()
    return generatePlan({
      rules: game.rules,
      formation,
      roster: available,
      attendance,
      seed: 1,
    }).target
  }, [game, formation, available, attendance])

  if (!game || !roster) return <AppBar title="Plan" back={`/team/${teamId}/games`} />

  async function build(nextSeed?: number, pins?: Pin[]) {
    if (!game) return
    setBusy(true)
    try {
      const result = generatePlan({
        rules: game.rules,
        formation,
        roster: available,
        attendance,
        pairings: pairings ?? [],
        pins: pins ?? plan?.pins ?? [],
        seed: nextSeed ?? Math.floor(Math.random() * 2 ** 31),
      })
      await savePlan(gameId, result.shifts, result.seed, pins ?? plan?.pins ?? [])
    } finally {
      setBusy(false)
    }
  }

  /** A hand edit is a decision, so it pins itself. */
  async function assign(shiftIndex: number, slotId: SlotId, playerId: string) {
    if (!plan) return
    const shifts: PlannedShift[] = plan.shifts.map((s) => ({
      ...s,
      assignments: { ...s.assignments },
    }))
    const shift = shifts[shiftIndex]
    if (!shift) return

    const displaced = shift.assignments[slotId]
    const elsewhere = Object.entries(shift.assignments).find(
      ([sid, pid]) => pid === playerId && sid !== slotId,
    )

    shift.assignments[slotId] = playerId
    let pins = togglePin(plan.pins, { shiftIndex, slotId, playerId })
    // Re-pin if toggle removed it — an explicit assignment always pins.
    if (!isPinned(pins, shiftIndex, slotId)) {
      pins = [...pins, { shiftIndex, slotId, playerId }]
    }

    if (elsewhere) {
      // Straight swap, so the other slot does not end up empty.
      const [otherSlot] = elsewhere
      if (displaced) {
        shift.assignments[otherSlot] = displaced
        pins = togglePin(pins, {
          shiftIndex,
          slotId: otherSlot,
          playerId: displaced,
        })
      } else {
        delete shift.assignments[otherSlot]
      }
    }

    await savePlan(gameId, shifts, plan.seed, pins)
    setCell(null)
  }

  async function flipPin(shiftIndex: number, slotId: SlotId) {
    if (!plan) return
    const playerId = plan.shifts[shiftIndex]?.assignments[slotId]
    if (!playerId) return
    const pins = togglePin(plan.pins, { shiftIndex, slotId, playerId })
    await savePlan(gameId, plan.shifts, plan.seed, pins)
    setCell(null)
  }

  const byId = new Map(roster.map((p) => [p.id, p]))
  const slotById = new Map(formation.slots.map((s) => [s.id, s]))
  const pinCount = plan?.pins.length ?? 0

  return (
    <>
      <AppBar
        title="Plan"
        sub={`${game.homeAway === 'home' ? 'v' : 'at'} ${game.opponent}`}
        back={`/team/${teamId}/game/${gameId}`}
        action={
          plan ? (
            <>
              <button type="button" onClick={() => window.print()} aria-label="Print">
                Print
              </button>
              <button type="button" disabled={busy} onClick={() => void build()}>
                ↻ Re-roll
              </button>
            </>
          ) : undefined
        }
      />
      <main>
        {available.length < game.rules.playersOnField ? (
          <div className="error">
            Only {available.length} players are marked available, and{' '}
            {game.rules.playersOnField} are needed on the field. Set attendance first.
          </div>
        ) : null}

        {plan ? (
          <div className="printonly print-head">
            <h1>
              {team?.name ?? 'Team'} — {game.homeAway === 'home' ? 'v' : 'at'}{' '}
              {game.opponent}
            </h1>
            <p>
              {new Date(game.kickoffAt).toLocaleString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                hour: 'numeric',
                minute: '2-digit',
              })}
              {' · '}
              {game.rules.periodCount} × {game.rules.periodMinutes} min
              {' · '}
              {formation.name}
              {' · sub every '}
              {game.rules.shiftMinutes} min
            </p>
          </div>
        ) : null}

        {!plan ? (
          <div className="empty">
            <strong>No plan yet</strong>
            Build a shift chart that gives everyone an even share of the game. You can
            pin anything you like, then re-roll the rest.
            <div className="btn-row" style={{ marginTop: '1.2rem' }}>
              <button
                type="button"
                className="btn primary"
                disabled={busy || available.length === 0}
                onClick={() => void build()}
              >
                Build the plan
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="gridwrap">
              <table className="plan">
                <thead>
                  <tr>
                    <th className="nm">&nbsp;</th>
                    {grid.map((s, i) => {
                      const first = i === 0 || grid[i - 1]?.period !== s.period
                      return (
                        <th key={s.index} className={first && i > 0 ? 'qsep' : undefined}>
                          {first ? `Q${s.period}` : ''}
                        </th>
                      )
                    })}
                    <th>Min</th>
                  </tr>
                </thead>
                <tbody>
                  {available.map((p) => {
                    const played = totals.get(p.id) ?? 0
                    const targ = targets.get(p.id) ?? 0
                    const dev = played - targ
                    const tone =
                      Math.abs(dev) <= 100 ? 'ok' : dev < 0 ? 'owed' : 'over'
                    return (
                      <tr key={p.id}>
                        <td className="nm">{displayName(p, available)}</td>
                        {grid.map((slice, i) => {
                          const shift = plan.shifts[i]
                          const entry = shift
                            ? Object.entries(shift.assignments).find(
                                ([, pid]) => pid === p.id,
                              )
                            : undefined
                          const slot = entry ? slotById.get(entry[0]) : undefined
                          const pinned =
                            entry !== undefined && isPinned(plan.pins, i, entry[0])
                          const first =
                            i === 0 || grid[i - 1]?.period !== slice.period
                          return (
                            <td
                              key={slice.index}
                              className={first && i > 0 ? 'qsep' : undefined}
                            >
                              {slot && entry ? (
                                <button
                                  type="button"
                                  className={`cel ${slot.group}${pinned ? ' pinned' : ''}`}
                                  onClick={() =>
                                    setCell({ shiftIndex: i, slotId: entry[0] })
                                  }
                                  aria-label={`${fullName(p)}, ${slot.label}, shift ${i + 1}`}
                                >
                                  {slot.label}
                                </button>
                              ) : (
                                <span className="cel bench" aria-label="on the bench">
                                  ·
                                </span>
                              )}
                            </td>
                          )
                        })}
                        <td className="tot">
                          {minutes(played)}
                          <div className={`deficit ${tone}`}>{signedMmss(-dev)}</div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="legend">
              <span>
                <i className="swatch" style={{ background: '#c99a12' }} /> Keeper
              </span>
              <span>
                <i className="swatch" style={{ background: '#2f6f4f' }} /> Defence
              </span>
              <span>
                <i className="swatch" style={{ background: '#3a6f96' }} /> Midfield
              </span>
              <span>
                <i className="swatch" style={{ background: '#a8543f' }} /> Attack
              </span>
            </div>

            <div className="section-label">Balance</div>
            <div className="card pad noprint">
              <input
                className="slider"
                type="range"
                min={0}
                max={100}
                value={Math.round(game.rules.balance * 100)}
                aria-label="Balance"
                onChange={(e) =>
                  void updateRules(gameId, { balance: Number(e.target.value) / 100 })
                }
              />
              <div className="slider-ends">
                <span>Strictly equal</span>
                <span>Loose</span>
              </div>
              <div className="dim" style={{ marginTop: '0.5rem' }}>
                {pinCount > 0
                  ? `${pinCount} cell${pinCount === 1 ? '' : 's'} pinned. Re-rolling keeps them.`
                  : 'Tap any cell to pin it, then re-roll to shuffle everything else.'}
              </div>
            </div>
          </>
        )}
      </main>

      {cell && plan ? (
        <CellSheet
          formation={formation}
          plan={plan.shifts}
          pins={plan.pins}
          cell={cell}
          roster={byId}
          eligible={[
            ...eligibleDuring(windows, grid[cell.shiftIndex] ?? grid[0]!),
          ].filter((id) => byId.has(id))}
          onClose={() => setCell(null)}
          onAssign={(pid) => void assign(cell.shiftIndex, cell.slotId, pid)}
          onFlipPin={() => void flipPin(cell.shiftIndex, cell.slotId)}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------- cell sheet

function CellSheet({
  formation,
  plan,
  pins,
  cell,
  roster,
  eligible,
  onClose,
  onAssign,
  onFlipPin,
}: {
  formation: Formation
  plan: PlannedShift[]
  pins: Pin[]
  cell: CellTarget
  roster: Map<string, Player>
  eligible: string[]
  onClose: () => void
  onAssign: (playerId: string) => void
  onFlipPin: () => void
}) {
  const slot = formation.slots.find((s) => s.id === cell.slotId)
  const shift = plan[cell.shiftIndex]
  const current = shift?.assignments[cell.slotId]
  const pinned = isPinned(pins, cell.shiftIndex, cell.slotId)
  const onFieldNow = new Set(Object.values(shift?.assignments ?? {}))

  const isKeeperSlot = slot?.requiredRole === 'GK'
  const candidates = eligible
    .map((id) => roster.get(id))
    .filter((p): p is Player => !!p)
    .filter((p) => (isKeeperSlot ? p.gk !== 'never' : true))
    .sort((a, b) => nameSortKey(a).localeCompare(nameSortKey(b)))

  return (
    <Sheet
      title={`${slot?.label ?? 'Slot'} · shift ${cell.shiftIndex + 1}`}
      onClose={onClose}
    >
      <div className="btn-row" style={{ marginTop: 0, marginBottom: '0.9rem' }}>
        <button type="button" className={`btn${pinned ? ' primary' : ''}`} onClick={onFlipPin}>
          {pinned ? '✓ Pinned' : 'Pin this cell'}
        </button>
      </div>

      <div className="section-label" style={{ marginTop: 0 }}>
        Who plays here
      </div>
      <div className="card">
        {candidates.map((p) => (
          <button
            key={p.id}
            type="button"
            className="row"
            onClick={() => onAssign(p.id)}
            aria-pressed={p.id === current}
          >
            <span className="grow">
              <span className="name">{fullName(p)}</span>
              <span className="meta">
                {p.id === current
                  ? 'Playing here'
                  : onFieldNow.has(p.id)
                    ? 'On the field — will swap places'
                    : 'On the bench this shift'}
              </span>
            </span>
            {p.id === current ? <span className="chev">✓</span> : null}
          </button>
        ))}
        {candidates.length === 0 ? (
          <div className="pad dim">Nobody is available for this shift.</div>
        ) : null}
      </div>

      <div className="dim" style={{ marginTop: '0.7rem' }}>
        Picking someone pins the cell.
      </div>
    </Sheet>
  )
}
