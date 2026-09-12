import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, rosterOf } from '@/db/db'
import { setAttendance, updateGame } from '@/db/games'
import { appendMany, eventsOf, undoLastGroup } from '@/db/events'
import { loadPlan, savePlan } from '@/db/plans'
import { reconcileAttendance } from '@/domain/attendance'
import { BUILT_IN_FORMATIONS, findFormation } from '@/domain/formations'
import {
  buildShiftGrid,
  minutes,
  mmss,
  outfieldShareUpTo,
} from '@/domain/fairness'
import {
  applyDiff,
  currentShiftIndex,
  deriveLive,
  diffToPlan,
  isSubDue,
  outfieldPlayed,
  planFieldChange,
  secondsUntilShift,
  type LiveState,
  type SubPlan,
} from '@/domain/live'
import { generatePlan, replanFrom } from '@/domain/planner'
import type { Formation, GameEventBody, Pin, Player, SlotId } from '@/domain/types'
import { displayName, fullName } from '@/domain/types'
import Pitch, { type SlotFill } from '../components/Pitch'
import LineupEditor from '../components/LineupEditor'
import PlayingTime from '../components/PlayingTime'
import Sheet from '../components/Sheet'
import { useNow, useWakeLock } from '../hooks/useLive'

const ON_DECK_LEAD_SEC = 60

export default function Live() {
  const { teamId = '', gameId = '' } = useParams()
  const nav = useNavigate()

  const game = useLiveQuery(() => db.games.get(gameId), [gameId])
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
  const plan = useLiveQuery(async () => (await loadPlan(gameId)) ?? null, [gameId])
  const events = useLiveQuery(() => eventsOf(gameId), [gameId])

  const [menu, setMenu] = useState(false)
  const [scoring, setScoring] = useState<null | 'goal' | 'assist'>(null)
  const [scorer, setScorer] = useState<string | null>(null)
  const [slotSheet, setSlotSheet] = useState<{
    slotId: SlotId
    playerId?: string
  } | null>(null)
  const [snoozeUntilSec, setSnoozeUntilSec] = useState(0)
  const [whoIsHere, setWhoIsHere] = useState(false)
  const [manualSub, setManualSub] = useState(false)
  const [namePick, setNamePick] = useState<
    { kind: 'in' | 'out'; player: string } | { kind: 'keeper' } | null
  >(null)
  const [editShiftIdx, setEditShiftIdx] = useState<number | null>(null)
  const [toast, setToast] = useState<string | null>(null)

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

  // Ticks only to force a re-render; the clock itself comes from timestamps,
  // so a missed tick costs nothing and a locked phone catches up on wake.
  const now = useNow(true)
  const s: LiveState | null = useMemo(
    () => (game ? deriveLive(events ?? [], game.rules, formation, now) : null),
    [game, events, formation, now],
  )
  useWakeLock(s?.running ?? false)

  // A coach who opens match day should find a lineup waiting, not an empty
  // pitch and a decision. Generated once, and freely shuffled or edited after.
  const [autoBuilt, setAutoBuilt] = useState(false)
  useEffect(() => {
    if (autoBuilt || !game || plan !== null) return
    // Short-handed is a normal Saturday. The planner fills what it can and
    // everyone plays the whole game; refusing to start would strand the coach.
    if (available.length === 0) return
    setAutoBuilt(true)
    const result = generatePlan({
      rules: game.rules,
      formation,
      roster: available,
      attendance,
      pairings: pairings ?? [],
      seed: Math.floor(Math.random() * 2 ** 31),
    })
    void savePlan(gameId, result.shifts, result.seed, [])
  }, [autoBuilt, game, plan, available, attendance, pairings, formation, gameId])

  if (!game || !roster || !s) return <div className="live" />

  const rules = game.rules
  const grid = buildShiftGrid(rules)
  const periodSec = rules.periodMinutes * 60
  const byId = new Map(roster.map((p) => [p.id, p]))
  /** Shout-ready name: first name unless two players share it. */
  const show = (id: string): string => {
    const p = byId.get(id)
    return p ? displayName(p, available) : '?'
  }

  const gkSlotId = formation.slots.find((sl) => sl.requiredRole === 'GK')?.id

  const shiftIdx =
    s.period > 0 ? currentShiftIndex(grid, rules, s.period, s.periodElapsedSec) : -1
  const currentShift = shiftIdx >= 0 ? plan?.shifts[shiftIdx] : undefined

  // Deliberately never crosses into the next period. Bringing a change forward
  // across the interval would schedule players meant for after the break, and
  // would offer the next period's goalkeeper change at a throw-in.
  const peeked = shiftIdx >= 0 ? plan?.shifts[shiftIdx + 1] : undefined
  const nextShift = peeked?.period === s.period ? peeked : undefined

  const slotLabel = (id: SlotId): string =>
    formation.slots.find((x) => x.id === id)?.label ?? ''
  const slotGroup = (id: SlotId): string =>
    formation.slots.find((x) => x.id === id)?.group ?? 'MID'

  const lineupOpts = {
    slots: formation.slots,
    avoids: new Map(roster.map((p) => [p.id, p.avoidGroups])),
  }
  // During play the goal is left alone: a keeper change is made by tapping the
  // keeper, or at a period break, never proposed at a stoppage.
  const subOpts = { ...lineupOpts, ignoreKeeper: true }

  const sub = diffToPlan(s.onField, currentShift?.assignments ?? {}, subOpts)
  const due = s.status === 'running' && isSubDue(sub) && !!currentShift
  const showSubSheet = due && s.cumulativeSec >= snoozeUntilSec

  // What a "make subs" tap would do: whatever is already due, otherwise the
  // next scheduled change brought forward to this stoppage.
  const earlySub = nextShift
    ? diffToPlan(s.onField, nextShift.assignments, subOpts)
    : null
  const nextChange =
    isSubDue(sub) && currentShift
      ? { shift: currentShift, diff: sub, index: shiftIdx }
      : nextShift && earlySub && isSubDue(earlySub)
        ? { shift: nextShift, diff: earlySub, index: shiftIdx + 1 }
        : null
  const activeSub = showSubSheet || manualSub ? nextChange : null

  /** Who the next change brings on. Known as soon as there is a plan, not
   *  only in the last minute, so a coach can warn them in good time. */
  const comingOn = new Set<string>(
    nextChange
      ? [
          ...nextChange.diff.swaps.map((w) => w.on),
          ...nextChange.diff.onOnly.map((o) => o.playerId),
          ...(nextChange.diff.keeper ? [nextChange.diff.keeper.on] : []),
        ]
      : [],
  )

  const untilNext = nextShift
    ? secondsUntilShift(nextShift, rules, s.periodElapsedSec)
    : periodSec - s.periodElapsedSec

  /**
   * Everything about who goes on next is judged on outfield play, matching how
   * the planner shares it out: goal duty is rotated separately and neither
   * earns credit nor leaves a debt. Judging it on total minutes would show a
   * keeper as over-played the moment they left the goal and quietly push them
   * to the back of the queue for the rest of the game.
   */
  const outPlayed = outfieldPlayed(s)
  const shareNow = outfieldShareUpTo(
    rules,
    attendance,
    s.keeperSpans,
    formation.slots.filter((sl) => sl.requiredRole !== 'GK').length,
    s.cumulativeSec,
  )

  function owedSec(playerId: string): number {
    return (shareNow.get(playerId) ?? 0) - (outPlayed.get(playerId) ?? 0)
  }

  function toneFor(playerId: string): 'ok' | 'behind' | 'short' {
    // A keeper is exactly where they should be, so the figure on their chip is
    // never a reproach.
    if (playerId === s!.onField[gkSlotId ?? '']) return 'ok'
    const owed = owedSec(playerId)
    if (owed > 180) return 'short'
    if (owed > 60) return 'behind'
    return 'ok'
  }

  const onFieldIds = new Set(Object.values(s.onField))
  const bench = available
    .filter((p) => !onFieldIds.has(p.id))
    .sort((a, b) => owedSec(b.id) - owedSec(a.id))



  // ---------------------------------------------------------------- lineup

  const startAssign: Record<SlotId, string> = plan?.shifts[0]?.assignments ?? {}

  /** First shift of the period about to start, during a break. */
  const nextPeriodIdx = grid.findIndex((sl) => sl.period === s.period + 1)
  const breakLineup: Record<SlotId, string> =
    nextPeriodIdx >= 0 ? (plan?.shifts[nextPeriodIdx]?.assignments ?? {}) : {}

  /**
   * Put a player into one position of one shift of the plan.
   *
   * The choice is pinned and the rest of the game re-planned around it, so
   * overruling the chart never quietly costs the player who was displaced
   * their share of the game. Everything the coach can edit — the starting
   * eleven, a period break, a substitution — comes through here.
   */
  async function setLineupAt(shiftIndex: number, slotId: SlotId, playerId: string) {
    if (!plan || !game) return
    const shifts = plan.shifts.map((sh) => ({
      ...sh,
      assignments: { ...sh.assignments },
    }))
    const target = shifts[shiftIndex]
    if (!target) return

    const displaced = target.assignments[slotId]
    const elsewhere = Object.entries(target.assignments).find(
      ([sid, pid]) => pid === playerId && sid !== slotId,
    )
    target.assignments[slotId] = playerId
    if (elsewhere) {
      // Straight swap, so no position is left empty.
      const [otherSlot] = elsewhere
      if (displaced) target.assignments[otherSlot] = displaced
      else delete target.assignments[otherSlot]
    }

    const touched = new Set([slotId, ...(elsewhere ? [elsewhere[0]] : [])])
    const pins: Pin[] = [
      ...plan.pins.filter(
        (pin) => !(pin.shiftIndex === shiftIndex && touched.has(pin.slotId)),
      ),
      { shiftIndex, slotId, playerId },
      ...(elsewhere && displaced
        ? [{ shiftIndex, slotId: elsewhere[0], playerId: displaced }]
        : []),
    ]

    // Once the game is underway the minutes already played are the truth; before
    // kick-off there are none and the planner should count the plan instead.
    const started = s!.period > 0
    const result = generatePlan({
      rules: game.rules,
      formation,
      roster: available,
      attendance,
      pairings: pairings ?? [],
      pins,
      seed: plan.seed,
      existing: shifts,
      fromShiftIndex: shiftIndex + 1,
      ...(started ? { startingCredit: outPlayed } : {}),
    })
    await savePlan(gameId, result.shifts, result.seed, pins)
  }

  /** Re-deal the chart from this shift on, dropping any pins it would fight. */
  async function reshuffleFrom(shiftIndex: number) {
    if (!game || !plan) return
    const kept = plan.pins.filter((pin) => pin.shiftIndex < shiftIndex)
    const started = s!.period > 0
    const result = generatePlan({
      rules: game.rules,
      formation,
      roster: available,
      attendance,
      pairings: pairings ?? [],
      pins: kept,
      seed: Math.floor(Math.random() * 2 ** 31),
      existing: plan.shifts,
      fromShiftIndex: shiftIndex,
      ...(started ? { startingCredit: outPlayed } : {}),
    })
    await savePlan(gameId, result.shifts, result.seed, kept)
  }

  // ---------------------------------------------------------------- actions

  /**
   * Translate a planned change into events.
   *
   * Off first so the shirts are free, then the goal, then on. The goal is not
   * an interchangeable shirt — someone has to take the gloves — so a keeper
   * change is either a trade of places on the field or a straight swap with
   * the bench, and is the one case where a player staying on changes position.
   */
  function eventsForDiff(diff: SubPlan): GameEventBody[] {
    const offs: GameEventBody[] = []
    const moves: GameEventBody[] = []
    const ons: GameEventBody[] = []

    if (diff.keeper) {
      const k = diff.keeper
      if (k.tradeSlotId) {
        moves.push({
          type: 'MOVE',
          playerId: k.on,
          fromSlotId: k.tradeSlotId,
          toSlotId: k.gkSlotId,
        })
        moves.push({
          type: 'MOVE',
          playerId: k.off,
          fromSlotId: k.gkSlotId,
          toSlotId: k.tradeSlotId,
        })
      } else {
        offs.push({ type: 'OFF', playerId: k.off, slotId: k.gkSlotId })
        ons.push({ type: 'ON', playerId: k.on, slotId: k.gkSlotId })
      }
    }

    for (const sw of diff.swaps) {
      offs.push({ type: 'OFF', playerId: sw.off, slotId: sw.offSlot })
      ons.push({ type: 'ON', playerId: sw.on, slotId: sw.onSlot })
    }
    for (const o of diff.offOnly) {
      offs.push({ type: 'OFF', playerId: o.playerId, slotId: o.slotId })
    }
    for (const o of diff.onOnly) {
      ons.push({ type: 'ON', playerId: o.playerId, slotId: o.slotId })
    }
    return [...offs, ...moves, ...ons]
  }

  /**
   * Start a period with the lineup the coach settled on during the break.
   *
   * PERIOD_START goes first so that a keeper coming on is credited to the
   * period they are about to play, not the one that just finished. Applying
   * the changes here rather than after kick-off means play resumes with the
   * right eleven already on, instead of a substitution prompt appearing the
   * moment the whistle goes.
   */
  async function startPeriod(period: number) {
    const idx = grid.findIndex((sl) => sl.period === period)
    const lineup = idx >= 0 ? (plan?.shifts[idx]?.assignments ?? {}) : {}
    const bodies: GameEventBody[] = [{ type: 'PERIOD_START', period }]

    if (period === 1) {
      for (const [slotId, playerId] of Object.entries(lineup)) {
        bodies.push({ type: 'ON', playerId, slotId })
      }
    } else {
      bodies.push(...eventsForDiff(diffToPlan(s!.onField, lineup, lineupOpts)))
    }

    await appendMany(gameId, bodies, s!.cumulativeSec)
    if (game!.status !== 'live') {
      // The scheduled time is a guess; this is when the whistle actually went.
      await updateGame(gameId, {
        status: 'live',
        ...(game!.startedAt ? {} : { startedAt: Date.now() }),
      })
    }
  }

  /**
   * Ending a period is confirmed because it is one tap from ending the game,
   * and the alert band that offers it is a large target near the top of the
   * screen — easy to catch by accident while reaching for the clock.
   */
  async function endPeriod() {
    const last = s!.period >= rules.periodCount
    const asked = last
      ? confirm(
          `End the game?\n\n${minutes(s!.cumulativeSec)} played. You can reopen it afterwards if this was a mistake.`,
        )
      : confirm(`End Q${s!.period}? ${mmss(s!.periodElapsedSec)} played this quarter.`)
    if (!asked) return

    await appendMany(gameId, [{ type: 'PERIOD_END', period: s!.period }], s!.cumulativeSec)
    setMenu(false)
    if (last) {
      await updateGame(gameId, { status: 'final', endedAt: Date.now() })
    }
  }

  async function togglePause() {
    await appendMany(
      gameId,
      [{ type: s!.running ? 'CLOCK_PAUSE' : 'CLOCK_RESUME' }],
      s!.cumulativeSec,
    )
  }

  /** Make the plan match reality from this shift onward. */
  async function replanRemainder(fromIdx: number, onField: Record<SlotId, string>) {
    if (!plan || !game) return
    const result = replanFrom(
      {
        rules: game.rules,
        formation,
        roster: available,
        attendance,
        pairings: pairings ?? [],
        pins: plan.pins,
        seed: plan.seed,
      },
      Math.max(0, fromIdx),
      outPlayed,
      onField,
      plan.shifts,
    )
    await savePlan(
      gameId,
      result.shifts,
      result.seed,
      plan.pins.filter((p) => p.shiftIndex > fromIdx),
    )
  }

  async function confirmSub(diff: SubPlan, targetIndex: number, plannedRelSec: number) {
    await appendMany(gameId, eventsForDiff(diff), s!.cumulativeSec)
    setManualSub(false)
    setSnoozeUntilSec(0)

    if (targetIndex > shiftIdx) {
      // Brought forward from the next shift. The pitch now matches shift N+1
      // while the plan's current shift is still N — left alone, the sheet
      // sees that mismatch and immediately proposes swapping everyone back.
      // Hold what is on the pitch as the current shift and re-plan from there.
      await replanRemainder(shiftIdx, applyDiff(s!.onField, diff))
      setToast('Plan adjusted')
      window.setTimeout(() => setToast(null), 2200)
      return
    }

    const drift = s!.periodElapsedSec - plannedRelSec
    await afterSub(targetIndex, drift)
  }

  /**
   * The referee decides when play stops, so a sub landing early or late is
   * normal. Past a minute either way the remainder is quietly rebalanced rather
   * than left to drift.
   */
  async function afterSub(targetIndex: number, drift: number) {
    if (Math.abs(drift) > 60) {
      await replanRemainder(targetIndex + 1, {})
      setToast('Plan adjusted')
      window.setTimeout(() => setToast(null), 2200)
    }
  }

  /** Accept the field as it stands and rebalance what is left. */
  async function skipSub() {
    await replanRemainder(shiftIdx, s!.onField)
    setToast('Plan adjusted')
    window.setTimeout(() => setToast(null), 2200)
  }

  /**
   * Put a player into one position on the pitch, right now.
   *
   * One action covers all three things tapping a position can mean: bring
   * someone on, fill a gap, or have two players already on trade places. A
   * trade is two MOVEs, so neither child leaves the field and neither loses a
   * second — which is why swapping positions does not disturb the plan, while
   * a substitution rebalances what is left.
   */
  async function setFieldSlot(slotId: SlotId, playerId: string) {
    const change = planFieldChange(s!.onField, slotId, playerId)
    if (change.kind === 'none') {
      setSlotSheet(null)
      return
    }

    await appendMany(gameId, change.events, s!.cumulativeSec)
    setSlotSheet(null)

    if (change.kind === 'swap' && slotId !== gkSlotId) {
      // Nobody came off, so nobody is owed anything different.
      setToast('Positions swapped')
      window.setTimeout(() => setToast(null), 2200)
      return
    }

    await replanRemainder(Math.max(0, shiftIdx), change.nextField)
    setToast(slotId === gkSlotId ? `${show(playerId)} in goal` : 'Plan adjusted')
    window.setTimeout(() => setToast(null), 2200)
  }

  /**
   * Attendance can change after kick-off — someone turns up at half-time, or
   * has to leave. The window is set to now, so a late arrival is targeted at an
   * even share of what remains rather than the whole game.
   *
   * The game is re-read from storage rather than trusted from this render, so
   * the re-plan runs against the attendance that was actually written.
   */
  async function changeAttendance(playerId: string, arriving: boolean) {
    const at = Math.max(
      0,
      (Math.max(1, s!.period) - 1) * periodSec +
        Math.min(s!.periodElapsedSec, periodSec),
    )
    await setAttendance(
      gameId,
      playerId,
      arriving
        ? { status: 'late', availableFromSec: at, availableUntilSec: undefined }
        : at <= 0
          ? { status: 'absent', availableFromSec: undefined, availableUntilSec: undefined }
          : { status: 'leaveEarly', availableUntilSec: at, availableFromSec: undefined },
    )

    let field = s!.onField
    if (!arriving) {
      const slotId = Object.entries(field).find(([, pid]) => pid === playerId)?.[0]
      if (slotId) {
        await appendMany(
          gameId,
          [{ type: 'OFF', playerId, slotId }],
          s!.cumulativeSec,
        )
        field = Object.fromEntries(
          Object.entries(field).filter(([sid]) => sid !== slotId),
        )
      }
    }

    const fresh = await db.games.get(gameId)
    if (fresh && plan && roster) {
      const att = reconcileAttendance(fresh.attendance, roster)
      const stillIn = new Set(
        att.filter((a) => a.status !== 'absent').map((a) => a.playerId),
      )
      const result = replanFrom(
        {
          rules: fresh.rules,
          formation,
          roster: roster.filter((p) => stillIn.has(p.id)),
          attendance: att,
          pairings: pairings ?? [],
          pins: plan.pins,
          seed: plan.seed,
        },
        Math.max(0, shiftIdx),
        outPlayed,
        field,
        plan.shifts,
      )
      await savePlan(
        gameId,
        result.shifts,
        result.seed,
        plan.pins.filter((p) => p.shiftIndex > shiftIdx),
      )
    }
    setToast(arriving ? 'Added to the game' : 'Plan adjusted')
    window.setTimeout(() => setToast(null), 2200)
  }
  /** One tap. Saves are the keeper's line on the sheet, and they come fast. */
  async function logSave() {
    const keeper = gkSlotId ? s!.onField[gkSlotId] : undefined
    if (!keeper) return
    await appendMany(gameId, [{ type: 'SAVE', playerId: keeper }], s!.cumulativeSec)
    setMenu(false)
    setToast(`Save — ${show(keeper)}`)
    window.setTimeout(() => setToast(null), 1800)
  }

  async function logGoal(playerId: string | null, assistId: string | null) {
    const body: GameEventBody = { type: 'GOAL' }
    if (playerId) body.playerId = playerId
    if (assistId) body.assistId = assistId
    await appendMany(gameId, [body], s!.cumulativeSec)
    setScoring(null)
    setScorer(null)
  }

  // ---------------------------------------------------------------- render

  const fill: Partial<Record<SlotId, SlotFill>> = {}
  for (const [slotId, playerId] of Object.entries(s.onField)) {
    const p = byId.get(playerId)
    if (!p) continue
    fill[slotId] = {
      name: displayName(p, available),
      mins: minutes(s.playedSec.get(playerId) ?? 0),
      tone: toneFor(playerId),
    }
  }

  const lineupFill: Partial<Record<SlotId, SlotFill>> = {}
  for (const [slotId, playerId] of Object.entries(startAssign)) {
    const p = byId.get(playerId)
    if (p) lineupFill[slotId] = { name: displayName(p, available) }
  }

  const alert = (() => {
    if (s.status === 'pre') return null
    if (s.status === 'break' || s.status === 'final') return null
    // Ending the period outranks the paused notice: pausing at the whistle and
    // then wanting to end the quarter is the normal half-time sequence, and the
    // header's play button already says the clock is stopped.
    if (s.periodElapsedSec >= periodSec)
      return { cls: 'period', text: `End of Q${s.period} — tap to end`, action: endPeriod }
    if (s.status === 'paused')
      return { cls: 'paused', text: 'Paused — tap play to resume' }
    if (showSubSheet) return { cls: 'due', text: 'Sub when play stops' }
    if (untilNext <= ON_DECK_LEAD_SEC)
      return { cls: 'soon', text: `Next sub in ${mmss(Math.max(0, untilNext))}` }
    return { cls: '', text: `Next sub in ${mmss(Math.max(0, untilNext))}` }
  })()

  return (
    <div className="live">
      <header className="live-head">
        <button type="button" aria-label="Back" onClick={() => nav(`/team/${teamId}/game/${gameId}`)}>
          ‹
        </button>
        <span className="per">{s.period > 0 ? `Q${s.period}` : '—'}</span>
        <span className="clk">{mmss(s.periodElapsedSec)}</span>
        {s.status === 'running' || s.status === 'paused' ? (
          <button type="button" aria-label={s.running ? 'Pause' : 'Resume'} onClick={() => void togglePause()}>
            {s.running ? '❚❚' : '▶'}
          </button>
        ) : null}
        <button type="button" aria-label="More" onClick={() => setMenu(true)}>
          ⋯
        </button>
      </header>

      {alert ? (
        alert.action ? (
          <button type="button" className={`live-alert ${alert.cls}`} onClick={() => void alert.action!()}>
            {alert.text}
          </button>
        ) : (
          <div className={`live-alert ${alert.cls}`}>{alert.text}</div>
        )
      ) : null}

      {toast ? <div className="live-alert soon">{toast}</div> : null}

      <div className="live-body">
        {s.status === 'pre' ? (
          available.length === 0 ? (
            <div className="empty">
              <strong>Nobody is here yet</strong>
              Mark who has arrived under &ldquo;Who is here&rdquo; in the menu.
            </div>
          ) : (
            <LineupEditor
              formation={formation}
              assignments={startAssign}
              squad={available}
              label={
                available.length < rules.playersOnField
                  ? `Starting ${available.length} — short of ${rules.playersOnField}`
                  : `Starting ${rules.playersOnField}`
              }
              hint={
                available.length < rules.playersOnField
                  ? 'Everyone plays the whole game. Tap a position to move the gap.'
                  : 'Tap a position to change it.'
              }
              onPick={(slotId, playerId) => void setLineupAt(0, slotId, playerId)}
              onShuffle={() => void reshuffleFrom(0)}
              footer={
                <button
                  type="button"
                  className="cta-big"
                  disabled={Object.keys(startAssign).length === 0}
                  onClick={() => void startPeriod(1)}
                >
                  KICK OFF
                </button>
              }
            />
          )
        ) : s.status === 'break' ? (
          <>
            <div
              className="dim"
              style={{ textAlign: 'center', marginBottom: '0.7rem' }}
            >
              End of Q{s.period} · {minutes(s.cumulativeSec)} played
            </div>
            <LineupEditor
              formation={formation}
              assignments={breakLineup}
              squad={available}
              label={`Q${s.period + 1} lineup`}
              hint="Tap any position to change it, including the goal."
              minutesOf={(id) => minutes(outPlayed.get(id) ?? 0)}
              onPick={(slotId, playerId) =>
                void setLineupAt(nextPeriodIdx, slotId, playerId)
              }
              onShuffle={() => void reshuffleFrom(nextPeriodIdx)}
              footer={
                <>
                  <BreakChanges
                    diff={diffToPlan(s.onField, breakLineup, lineupOpts)}
                    show={show}
                  />
                  <button
                    type="button"
                    className="cta-big"
                    onClick={() => void startPeriod(s.period + 1)}
                  >
                    START Q{s.period + 1}
                  </button>
                </>
              }
            />
          </>
        ) : s.status === 'final' ? (
          <>
            <div className="empty" style={{ paddingBottom: '0.8rem' }}>
              <strong>Full time</strong>
              {s.goalCount} {s.goalCount === 1 ? 'goal' : 'goals'} ·{' '}
              {minutes(s.cumulativeSec)} played
            </div>
            <PlayingTime state={s} roster={available} share={shareNow} />
            <div className="btn-row" style={{ marginTop: '1.2rem' }}>
              <button
                type="button"
                className="btn brand"
                onClick={() => nav(`/team/${teamId}/game/${gameId}/recap`)}
              >
                Full summary
              </button>
            </div>
          </>
        ) : (
          <>
            <Pitch
              formation={formation}
              fill={fill}
              onSlotClick={(slot) =>
                setSlotSheet({ slotId: slot.id, playerId: s.onField[slot.id] })
              }
            />

            <div className="bench-strip">
              <div className="bench-row">
                <span className="lab">Bench</span>
                {bench.map((p) => (
                  <span
                    key={p.id}
                    className={`bchip2${comingOn.has(p.id) ? ' deck' : ''}`}
                  >
                    {displayName(p, available)}
                    <em>{comingOn.has(p.id) ? 'next on' : minutes(outPlayed.get(p.id) ?? 0)}</em>
                  </span>
                ))}
                {bench.length === 0 ? <span className="dim">Everyone is on</span> : null}
              </div>
            </div>

            {nextChange ? (
              <div className={`nextsub${untilNext <= ON_DECK_LEAD_SEC ? ' soon' : ''}`}>
                <div className="nextsub-head">
                  <span>Next sub</span>
                  <span className="when">
                    {nextChange.index === shiftIdx
                      ? 'due now'
                      : `in ${mmss(Math.max(0, untilNext))}`}
                  </span>
                </div>
                {nextChange.diff.keeper ? (
                  <div className="nextsub-row">
                    <span className="pos GK">GK</span>
                    <span className="who off">{show(nextChange.diff.keeper.off)}</span>
                    <span className="arr" aria-hidden="true">
                      &rarr;
                    </span>
                    <span className="who on">{show(nextChange.diff.keeper.on)}</span>
                  </div>
                ) : null}
                {nextChange.diff.swaps.map((sw) => (
                  <div className="nextsub-row" key={`${sw.off}-${sw.on}`}>
                    <span className={`pos ${slotGroup(sw.offSlot)}`}>
                      {slotLabel(sw.offSlot)}
                    </span>
                    <span className="who off">{show(sw.off)}</span>
                    <span className="arr" aria-hidden="true">
                      &rarr;
                    </span>
                    <span className="who on">{show(sw.on)}</span>
                  </div>
                ))}
                {nextChange.diff.offOnly.map((o) => (
                  <div className="nextsub-row" key={o.playerId}>
                    <span className={`pos ${slotGroup(o.slotId)}`}>
                      {slotLabel(o.slotId)}
                    </span>
                    <span className="who off">{show(o.playerId)}</span>
                    <span className="arr" aria-hidden="true">
                      &rarr;
                    </span>
                    <span className="who">bench</span>
                  </div>
                ))}
                {nextChange.diff.onOnly.map((o) => (
                  <div className="nextsub-row" key={o.playerId}>
                    <span className={`pos ${slotGroup(o.slotId)}`}>
                      {slotLabel(o.slotId)}
                    </span>
                    <span className="who">bench</span>
                    <span className="arr" aria-hidden="true">
                      &rarr;
                    </span>
                    <span className="who on">{show(o.playerId)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <button
              type="button"
              className="cta-big subs-btn"
              disabled={!nextChange}
              onClick={() => setManualSub(true)}
            >
              {nextChange ? 'MAKE SUBS' : 'NO SUBS DUE'}
            </button>
          </>
        )}
      </div>

      {/* ---------------------------------------------------------- sheets */}

      {activeSub ? (
        (() => {
          const plannedRel = Math.max(
            0,
            activeSub.shift.startSec - (s.period - 1) * periodSec,
          )
          const drift = s.periodElapsedSec - plannedRel
          const diff = activeSub.diff
          return (
            <Sheet
              title="Substitution"
              onClose={() => {
                setManualSub(false)
                if (showSubSheet) setSnoozeUntilSec(s.cumulativeSec + 60)
              }}
            >
              <div className="subhead">
                <div className="when">Planned {mmss(plannedRel)}</div>
                {drift > 5 ? (
                  <div className="late">+{mmss(drift)} late</div>
                ) : drift < -5 ? (
                  <div className="late">{mmss(-drift)} early</div>
                ) : null}
              </div>

              {diff.keeper ? (
                <div className="swap keeper">
                  <span className="side">
                    {show(diff.keeper.off)}
                    <em>out of goal</em>
                  </span>
                  <span className="arrow" aria-hidden="true">
                    &#9917;
                  </span>
                  <button
                    type="button"
                    className="side on"
                    onClick={() => setNamePick({ kind: 'keeper' })}
                  >
                    {show(diff.keeper.on)}
                    <em>{diff.keeper.tradeSlotId ? 'swaps into goal' : 'into goal'}</em>
                  </button>
                </div>
              ) : null}

              {diff.swaps.map((sw) => (
                <div className="swap" key={`${sw.off}-${sw.on}`}>
                  <button
                    type="button"
                    className="side"
                    onClick={() => setNamePick({ kind: 'out', player: sw.off })}
                  >
                    {show(sw.off)}
                    <em>{minutes(outPlayed.get(sw.off) ?? 0)} on field</em>
                  </button>
                  <span className="arrow">
                    <em className={`pos ${slotGroup(sw.offSlot)}`}>
                      {slotLabel(sw.offSlot)}
                    </em>
                    <span aria-hidden="true">&rarr;</span>
                  </span>
                  <button
                    type="button"
                    className="side on"
                    onClick={() => setNamePick({ kind: 'in', player: sw.on })}
                  >
                    {show(sw.on)}
                    <em>{minutes(outPlayed.get(sw.on) ?? 0)} on field</em>
                  </button>
                </div>
              ))}
              {diff.offOnly.map((o) => (
                <div className="swap" key={o.playerId}>
                  <span className="side">
                    {show(o.playerId)}
                    <em>{minutes(outPlayed.get(o.playerId) ?? 0)} on field</em>
                  </span>
                  <span className="arrow">
                    <em className={`pos ${slotGroup(o.slotId)}`}>
                      {slotLabel(o.slotId)}
                    </em>
                    <span aria-hidden="true">&rarr;</span>
                  </span>
                  <span className="side">bench</span>
                </div>
              ))}
              {diff.onOnly.map((o) => (
                <div className="swap" key={o.playerId}>
                  <span className="side">bench</span>
                  <span className="arrow">
                    <em className={`pos ${slotGroup(o.slotId)}`}>
                      {slotLabel(o.slotId)}
                    </em>
                    <span aria-hidden="true">&rarr;</span>
                  </span>
                  <span className="side on">
                    {show(o.playerId)}
                    <em>{minutes(outPlayed.get(o.playerId) ?? 0)} on field</em>
                  </span>
                </div>
              ))}

              <button
                type="button"
                className="cta-big"
                onClick={() =>
                  void confirmSub(diff, activeSub.index, plannedRel)
                }
              >
                &#10003; CONFIRM
              </button>
              <div className="hint">tap a name to change it</div>

              <div className="subacts">
                <button type="button" onClick={() => setEditShiftIdx(activeSub.index)}>
                  Change more&hellip;
                </button>
                <button type="button" onClick={() => void skipSub()}>
                  Skip
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setManualSub(false)
                    setSnoozeUntilSec(s.cumulativeSec + 60)
                  }}
                >
                  Delay 1:00
                </button>
              </div>
            </Sheet>
          )
        })()
      ) : null}

      {namePick && activeSub && plan ? (
        (() => {
          const idx = activeSub.index
          const target = plan.shifts[idx]?.assignments ?? {}
          const slotOf = (pid: string): SlotId | undefined =>
            Object.entries(target).find(([, x]) => x === pid)?.[0]

          let title = ''
          let choices: Player[] = []
          let apply: (playerId: string) => void = () => {}

          if (namePick.kind === 'keeper') {
            title = 'Who goes in goal?'
            choices = available.filter((p) => p.gk !== 'never')
            apply = (pid) => {
              if (gkSlotId) void setLineupAt(idx, gkSlotId, pid)
            }
          } else if (namePick.kind === 'in') {
            title = `On instead of ${show(namePick.player)}?`
            const slot = slotOf(namePick.player)
            choices = available.filter((p) => p.id !== namePick.player)
            apply = (pid) => {
              if (slot) void setLineupAt(idx, slot, pid)
            }
          } else {
            title = `Off instead of ${show(namePick.player)}?`
            // Only players staying on can be swapped into the outgoing role.
            choices = available.filter(
              (p) => onFieldIds.has(p.id) && slotOf(p.id) !== undefined,
            )
            apply = (pid) => {
              const slot = slotOf(pid)
              if (slot) void setLineupAt(idx, slot, namePick.player)
            }
          }

          return (
            <Sheet title={title} onClose={() => setNamePick(null)}>
              <div className="card">
                {choices
                  .slice()
                  .sort((a, b) => owedSec(b.id) - owedSec(a.id))
                  .map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="row"
                      onClick={() => {
                        apply(p.id)
                        setNamePick(null)
                      }}
                    >
                      <span className="grow">
                        <span className="name">{fullName(p)}</span>
                        <span className="meta">
                          {minutes(outPlayed.get(p.id) ?? 0)} on field
                          {onFieldIds.has(p.id) ? ' · playing' : ' · on the bench'}
                        </span>
                      </span>
                      <span className="chev" aria-hidden="true">
                        &rsaquo;
                      </span>
                    </button>
                  ))}
                {choices.length === 0 ? (
                  <div className="pad dim">Nobody else to choose from.</div>
                ) : null}
              </div>
            </Sheet>
          )
        })()
      ) : null}

      {editShiftIdx !== null && plan ? (
        <Sheet title="Change the lineup" onClose={() => setEditShiftIdx(null)}>
          <LineupEditor
            formation={formation}
            assignments={plan.shifts[editShiftIdx]?.assignments ?? {}}
            squad={available}
            label="Who is on"
            hint="Tap any position. Nothing happens until you confirm the substitution."
            minutesOf={(id) => minutes(outPlayed.get(id) ?? 0)}
            onPick={(slotId, playerId) =>
              void setLineupAt(editShiftIdx, slotId, playerId)
            }
            footer={
              <button
                type="button"
                className="cta-big"
                onClick={() => setEditShiftIdx(null)}
              >
                DONE
              </button>
            }
          />
        </Sheet>
      ) : null}

      {slotSheet ? (
        (() => {
          const label =
            formation.slots.find((x) => x.id === slotSheet.slotId)?.label ?? 'Position'
          const isGoal = slotSheet.slotId === gkSlotId
          const here = slotSheet.playerId

          // Only players who will go in goal are offered the gloves, unless
          // nobody on this roster will, in which case the choice has to be made
          // from whoever is there.
          const eligible = isGoal
            ? available.some((p) => p.gk !== 'never')
              ? available.filter((p) => p.gk !== 'never')
              : available
            : available

          const comeOn = eligible
            .filter((p) => !onFieldIds.has(p.id))
            .sort((a, b) => owedSec(b.id) - owedSec(a.id))
          const trade = eligible
            .filter((p) => onFieldIds.has(p.id) && p.id !== here)
            .sort((a, b) => a.firstName.localeCompare(b.firstName))

          const row = (p: Player, swap: boolean) => (
            <button
              key={p.id}
              type="button"
              className="row"
              onClick={() => void setFieldSlot(slotSheet.slotId, p.id)}
            >
              <span className="grow">
                <span className="name">{fullName(p)}</span>
                <span className="meta">
                  {minutes(outPlayed.get(p.id) ?? 0)} on field
                  {swap
                    ? ` · now at ${
                        formation.slots.find((x) => x.id === s.slotOf.get(p.id))?.label ??
                        'on'
                      }`
                    : ` · owed ${mmss(Math.max(0, owedSec(p.id)))}`}
                </span>
              </span>
              <span className="chev" aria-hidden="true">
                &rsaquo;
              </span>
            </button>
          )

          return (
            <Sheet
              title={isGoal ? 'Who goes in goal?' : `Who plays ${label}?`}
              onClose={() => setSlotSheet(null)}
            >
              {here ? (
                <div className="dim" style={{ marginBottom: '0.6rem' }}>
                  {show(here)} is there now.
                </div>
              ) : null}

              <div className="section-label" style={{ marginTop: 0 }}>
                Bring on
              </div>
              <div className="card">
                {comeOn.map((p) => row(p, false))}
                {comeOn.length === 0 ? (
                  <div className="pad dim">Nobody is on the bench.</div>
                ) : null}
              </div>

              <div className="section-label">Swap positions with</div>
              <div className="card">
                {trade.map((p) => row(p, true))}
                {trade.length === 0 ? (
                  <div className="pad dim">Nobody else is on the field.</div>
                ) : null}
              </div>
              <div className="dim" style={{ marginTop: '0.6rem' }}>
                Swapping positions keeps both on the field. Nobody loses a minute.
              </div>
            </Sheet>
          )
        })()
      ) : null}

      {scoring === 'goal' ? (
        <Sheet title="Who scored?" onClose={() => setScoring(null)}>
          <div className="card">
            {Object.values(s.onField).map((id) => (
              <button
                key={id}
                type="button"
                className="row"
                onClick={() => {
                  setScorer(id)
                  setScoring('assist')
                }}
              >
                <span className="grow">
                  <span className="name">{show(id)}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => void logGoal(null, null)}>
              Not sure
            </button>
          </div>
        </Sheet>
      ) : null}

      {scoring === 'assist' ? (
        <Sheet title="Assisted by?" onClose={() => void logGoal(scorer, null)}>
          <div className="card">
            {Object.values(s.onField)
              .filter((id) => id !== scorer)
              .map((id) => (
                <button
                  key={id}
                  type="button"
                  className="row"
                  onClick={() => void logGoal(scorer, id)}
                >
                  <span className="grow">
                    <span className="name">{show(id)}</span>
                  </span>
                </button>
              ))}
          </div>
          <div className="btn-row">
            <button type="button" className="btn" onClick={() => void logGoal(scorer, null)}>
              No assist
            </button>
          </div>
        </Sheet>
      ) : null}

      {whoIsHere ? (
        (() => {
          const inGame = new Set(available.map((p) => p.id))
          const notHere = roster.filter((p) => p.active && !inGame.has(p.id))
          return (
            <Sheet title="Who is here" onClose={() => setWhoIsHere(false)}>
              {notHere.length > 0 ? (
                <>
                  <div className="section-label" style={{ marginTop: 0 }}>
                    Just arrived
                  </div>
                  <div className="card">
                    {notHere.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className="row"
                        onClick={() => {
                          setWhoIsHere(false)
                          void changeAttendance(p.id, true)
                        }}
                      >
                        <span className="grow">
                          <span className="name">{fullName(p)}</span>
                          <span className="meta">
                            Add now — even share of what is left
                          </span>
                        </span>
                        <span className="chev" aria-hidden="true">
                          +
                        </span>
                      </button>
                    ))}
                  </div>
                </>
              ) : null}

              <div className="section-label">Playing</div>
              <div className="card">
                {available.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="row"
                    onClick={() => {
                      if (!confirm(`${fullName(p)} has left for the day?`)) return
                      setWhoIsHere(false)
                      void changeAttendance(p.id, false)
                    }}
                  >
                    <span className="grow">
                      <span className="name">{fullName(p)}</span>
                      <span className="meta">
                        {minutes(s.playedSec.get(p.id) ?? 0)} played · tap if they
                        have gone
                      </span>
                    </span>
                  </button>
                ))}
              </div>

              {notHere.length === 0 ? (
                <div className="dim" style={{ marginTop: '0.7rem' }}>
                  Everyone on the roster is already in the game.
                </div>
              ) : null}
            </Sheet>
          )
        })()
      ) : null}

      {menu ? (
        <Sheet title="Game" onClose={() => setMenu(false)}>
          <div className="card">
            <button
              type="button"
              className="row"
              onClick={() => {
                setMenu(false)
                setScoring('goal')
              }}
              disabled={s.status !== 'running' && s.status !== 'paused'}
            >
              <span className="grow">
                <span className="name">Goal for us</span>
                <span className="meta">{s.goalCount} so far</span>
              </span>
            </button>
            <button
              type="button"
              className="row"
              disabled={!(gkSlotId && s.onField[gkSlotId])}
              onClick={() => void logSave()}
            >
              <span className="grow">
                <span className="name">Save</span>
                <span className="meta">
                  {gkSlotId && s.onField[gkSlotId]
                    ? `Credited to ${show(s.onField[gkSlotId])}`
                    : 'Nobody is in goal'}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="row"
              onClick={() => {
                setMenu(false)
                setWhoIsHere(true)
              }}
            >
              <span className="grow">
                <span className="name">Who is here</span>
                <span className="meta">
                  Someone arrived late, or had to leave
                </span>
              </span>
              <span className="chev" aria-hidden="true">
                ›
              </span>
            </button>
            <button
              type="button"
              className="row"
              onClick={() => {
                void undoLastGroup(gameId)
                setMenu(false)
              }}
            >
              <span className="grow">
                <span className="name">Undo last action</span>
                <span className="meta">Cancels the last sub or goal</span>
              </span>
            </button>
            {s.status === 'running' || s.status === 'paused' ? (
              <button type="button" className="row" onClick={() => void endPeriod()}>
                <span className="grow">
                  <span className="name">End Q{s.period}</span>
                  <span className="meta">
                    Whenever the referee blows — early or late
                  </span>
                </span>
              </button>
            ) : null}
            <button
              type="button"
              className="row"
              onClick={() => {
                void appendMany(
                  gameId,
                  [{ type: 'CLOCK_ADJUST', deltaSec: 30, reason: 'manual' }],
                  s.cumulativeSec,
                )
              }}
            >
              <span className="grow">
                <span className="name">Clock is 30s fast</span>
                <span className="meta">Add half a minute to the game clock</span>
              </span>
            </button>
          </div>
          <div className="btn-row">
            <button
              type="button"
              className="btn"
              onClick={() => nav(`/team/${teamId}/game/${gameId}/plan`)}
            >
              See the shift chart
            </button>
          </div>
        </Sheet>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------- final
/** A one-line reminder of what tapping Start will actually change. */
function BreakChanges({
  diff,
  show,
}: {
  diff: SubPlan
  show: (id: string) => string
}) {
  const on = [...diff.swaps.map((w) => w.on), ...diff.onOnly.map((o) => o.playerId)]
  const off = [...diff.swaps.map((w) => w.off), ...diff.offOnly.map((o) => o.playerId)]
  if (!diff.keeper && on.length === 0 && off.length === 0) {
    return (
      <div className="dim" style={{ textAlign: 'center', marginTop: '0.7rem' }}>
        Same eleven as the end of the last period.
      </div>
    )
  }
  return (
    <div className="dim" style={{ textAlign: 'center', marginTop: '0.7rem' }}>
      {diff.keeper ? <>Goal: {show(diff.keeper.on)}. </> : null}
      {on.length > 0 ? <>On: {on.map(show).join(', ')}. </> : null}
      {off.length > 0 ? <>Off: {off.map(show).join(', ')}.</> : null}
    </div>
  )
}
