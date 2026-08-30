import type {
  Formation,
  GameEvent,
  GameRules,
  ID,
  PositionGroup,
  Slot,
  SlotId,
} from './types'
import { emptyGroupRecord } from './types'

/**
 * Everything the live screen shows, derived from the event log in one pass.
 *
 * Nothing here is a counter. The clock comes from wall-clock timestamps, so a
 * phone that spends a quarter in a pocket unlocks to the right time; minutes
 * come from ON/OFF pairs, so a mistimed substitution can be corrected after
 * the fact and every number downstream simply recomputes.
 */

export type ClockStatus = 'pre' | 'running' | 'paused' | 'break' | 'final'

export interface LiveState {
  status: ClockStatus
  running: boolean
  /** 0 before kick-off, otherwise the period in play or just finished. */
  period: number
  /** Seconds played in the current period. What the coach reads on screen. */
  periodElapsedSec: number
  /** Seconds of actual play across the whole game. What minutes are measured on. */
  cumulativeSec: number
  onField: Record<SlotId, ID>
  slotOf: Map<ID, SlotId>
  playedSec: Map<ID, number>
  gkSec: Map<ID, number>
  secByGroup: Map<ID, Record<PositionGroup, number>>
  gkPeriods: Map<ID, Set<number>>
  goals: Map<ID, number>
  assists: Map<ID, number>
  shots: Map<ID, number>
  saves: Map<ID, number>
  goalCount: number
  /** Game-clock second each surviving event happened at. */
  timeOf: Map<string, number>
  /** Events that survived voiding, in order. */
  live: GameEvent[]
}

/** Drop events cancelled by a VOID, and the VOIDs themselves. */
export function surviving(events: GameEvent[]): GameEvent[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  const voided = new Set<number>()
  for (const e of ordered) {
    if (e.body.type === 'VOID') voided.add(e.body.seq)
  }
  return ordered.filter((e) => e.body.type !== 'VOID' && !voided.has(e.seq))
}

export function deriveLive(
  events: GameEvent[],
  rules: GameRules,
  formation: Formation,
  nowMs: number,
): LiveState {
  const groupOf = new Map(formation.slots.map((s) => [s.id, s.group]))
  const gkSlotId = formation.slots.find((s) => s.requiredRole === 'GK')?.id

  const state: LiveState = {
    status: 'pre',
    running: false,
    period: 0,
    periodElapsedSec: 0,
    cumulativeSec: 0,
    onField: {},
    slotOf: new Map(),
    playedSec: new Map(),
    gkSec: new Map(),
    secByGroup: new Map(),
    gkPeriods: new Map(),
    goals: new Map(),
    assists: new Map(),
    shots: new Map(),
    saves: new Map(),
    goalCount: 0,
    timeOf: new Map(),
    live: [],
  }

  const live = surviving(events)
  state.live = live

  let cumulativeMs = 0
  let runningSince: number | null = null
  let periodStartCumulative = 0
  /** playerId -> { slotId, sinceSec } for the stint currently open. */
  const open = new Map<ID, { slotId: SlotId; sinceSec: number }>()

  const clockMs = (wallAt: number): number =>
    cumulativeMs + (runningSince !== null ? Math.max(0, wallAt - runningSince) : 0)

  const closeStint = (playerId: ID, atSec: number): void => {
    const stint = open.get(playerId)
    if (!stint) return
    const dur = Math.max(0, atSec - stint.sinceSec)
    state.playedSec.set(playerId, (state.playedSec.get(playerId) ?? 0) + dur)
    const group = groupOf.get(stint.slotId)
    if (group) {
      const rec = state.secByGroup.get(playerId) ?? emptyGroupRecord()
      rec[group] += dur
      state.secByGroup.set(playerId, rec)
    }
    if (stint.slotId === gkSlotId) {
      state.gkSec.set(playerId, (state.gkSec.get(playerId) ?? 0) + dur)
    }
    open.delete(playerId)
  }

  const bump = (m: Map<ID, number>, id: ID): void => {
    m.set(id, (m.get(id) ?? 0) + 1)
  }

  for (const e of live) {
    const tSec = clockMs(e.wallAt) / 1000
    state.timeOf.set(e.id, tSec)

    switch (e.body.type) {
      case 'PERIOD_START':
        state.period = e.body.period
        periodStartCumulative = cumulativeMs
        runningSince = e.wallAt
        state.status = 'running'
        break

      case 'PERIOD_END':
        cumulativeMs = clockMs(e.wallAt)
        runningSince = null
        state.status = e.body.period >= rules.periodCount ? 'final' : 'break'
        break

      case 'CLOCK_PAUSE':
        cumulativeMs = clockMs(e.wallAt)
        runningSince = null
        state.status = 'paused'
        break

      case 'CLOCK_RESUME':
        runningSince = e.wallAt
        state.status = 'running'
        break

      case 'CLOCK_ADJUST':
        cumulativeMs = Math.max(0, clockMs(e.wallAt) + e.body.deltaSec * 1000)
        if (runningSince !== null) runningSince = e.wallAt
        break

      case 'ON':
        closeStint(e.body.playerId, tSec)
        open.set(e.body.playerId, { slotId: e.body.slotId, sinceSec: tSec })
        state.onField[e.body.slotId] = e.body.playerId
        if (e.body.slotId === gkSlotId && state.period > 0) {
          const set = state.gkPeriods.get(e.body.playerId) ?? new Set<number>()
          set.add(state.period)
          state.gkPeriods.set(e.body.playerId, set)
        }
        break

      case 'OFF':
        closeStint(e.body.playerId, tSec)
        if (state.onField[e.body.slotId] === e.body.playerId) {
          delete state.onField[e.body.slotId]
        }
        break

      case 'MOVE': {
        // A position change is not a break in play, so the stint continues —
        // only the group the seconds are credited to changes.
        closeStint(e.body.playerId, tSec)
        open.set(e.body.playerId, { slotId: e.body.toSlotId, sinceSec: tSec })
        if (state.onField[e.body.fromSlotId] === e.body.playerId) {
          delete state.onField[e.body.fromSlotId]
        }
        state.onField[e.body.toSlotId] = e.body.playerId
        break
      }

      case 'GOAL':
        state.goalCount += 1
        if (e.body.playerId) bump(state.goals, e.body.playerId)
        if (e.body.assistId) bump(state.assists, e.body.assistId)
        break

      case 'SHOT':
        bump(state.shots, e.body.playerId)
        break

      case 'SAVE':
        bump(state.saves, e.body.playerId)
        break

      case 'NOTE':
      case 'VOID':
        break
    }
  }

  // Bring everything up to now.
  const nowCumulativeMs = clockMs(nowMs)
  const nowSec = nowCumulativeMs / 1000
  for (const [playerId] of [...open]) {
    const stint = open.get(playerId)!
    const dur = Math.max(0, nowSec - stint.sinceSec)
    state.playedSec.set(playerId, (state.playedSec.get(playerId) ?? 0) + dur)
    const group = groupOf.get(stint.slotId)
    if (group) {
      const rec = state.secByGroup.get(playerId) ?? emptyGroupRecord()
      rec[group] += dur
      state.secByGroup.set(playerId, rec)
    }
    if (stint.slotId === gkSlotId) {
      state.gkSec.set(playerId, (state.gkSec.get(playerId) ?? 0) + dur)
    }
    state.slotOf.set(playerId, stint.slotId)
  }

  state.running = runningSince !== null
  state.cumulativeSec = nowSec
  state.periodElapsedSec = Math.max(0, nowSec - periodStartCumulative / 1000)
  if (state.status === 'pre') state.periodElapsedSec = 0

  for (const [slotId, playerId] of Object.entries(state.onField)) {
    state.slotOf.set(playerId, slotId)
  }

  return state
}

// ---------------------------------------------------------------- shift maths

/**
 * Which planned shift the current period time falls in.
 *
 * Deliberately period-relative rather than cumulative: a referee who plays two
 * extra minutes in the first quarter should not push every later shift out of
 * alignment with the quarter it belongs to.
 */
export function currentShiftIndex(
  shifts: { index: number; period: number; startSec: number; endSec: number }[],
  rules: GameRules,
  period: number,
  periodElapsedSec: number,
): number {
  const periodSec = rules.periodMinutes * 60
  const inPeriod = shifts.filter((s) => s.period === period)
  if (inPeriod.length === 0) return -1
  for (const s of inPeriod) {
    const rel = s.startSec - (period - 1) * periodSec
    const relEnd = s.endSec - (period - 1) * periodSec
    if (periodElapsedSec < relEnd || s === inPeriod[inPeriod.length - 1]) {
      if (periodElapsedSec >= rel || s === inPeriod[0]) return s.index
    }
  }
  return inPeriod[inPeriod.length - 1]!.index
}

/** Seconds until the given shift is due to start, negative once it is overdue. */
export function secondsUntilShift(
  shift: { period: number; startSec: number },
  rules: GameRules,
  periodElapsedSec: number,
): number {
  const rel = shift.startSec - (shift.period - 1) * rules.periodMinutes * 60
  return rel - periodElapsedSec
}

export interface Swap {
  off: ID
  offSlot: SlotId
  on: ID
  onSlot: SlotId
}

export interface SubPlan {
  swaps: Swap[]
  /** Always empty: a substitution never repositions the players staying on. */
  moves: { playerId: ID; fromSlotId: SlotId; toSlotId: SlotId }[]
  offOnly: { playerId: ID; slotId: SlotId }[]
  onOnly: { playerId: ID; slotId: SlotId }[]
}

/**
 * Turn "who is on now" and "who the plan wants next" into the substitution a
 * coach actually makes: pairs of names, one off and one on.
 *
 * A substitution moves exactly the players being substituted. Whoever stays on
 * keeps the position they are already standing in, even where the plan had a
 * different idea — shuffling six children around the pitch to satisfy a chart
 * is disruptive, hard to shout, and buys nothing. So the player coming on
 * inherits the position of the player going off.
 *
 * Where there is a choice of vacated positions, the plan's intention is used as
 * a preference, then any position the incoming player does not avoid.
 */
export function diffToPlan(
  onField: Record<SlotId, ID>,
  target: Record<SlotId, ID>,
  opts?: { slots?: Slot[]; avoids?: Map<ID, PositionGroup[]> },
): SubPlan {
  const currentIds = new Set(Object.values(onField))
  const targetIds = new Set(Object.values(target))

  const offs: { playerId: ID; slotId: SlotId }[] = []
  for (const [slotId, playerId] of Object.entries(onField)) {
    if (!targetIds.has(playerId)) offs.push({ playerId, slotId })
  }
  const ons: { playerId: ID; slotId: SlotId }[] = []
  for (const [slotId, playerId] of Object.entries(target)) {
    if (!currentIds.has(playerId)) ons.push({ playerId, slotId })
  }

  const groupOf = new Map((opts?.slots ?? []).map((sl) => [sl.id, sl.group]))
  const free = [...offs]
  const swaps: Swap[] = []
  let matched = 0

  for (const on of ons) {
    if (free.length === 0) break
    const avoid = opts?.avoids?.get(on.playerId) ?? []
    const willing = (slotId: SlotId): boolean => {
      const g = groupOf.get(slotId)
      return !g || !avoid.includes(g)
    }
    // The position the plan had in mind, if it is opening up and they will
    // play there. A stated "not in defence" outranks the chart.
    let i = free.findIndex((f) => f.slotId === on.slotId && willing(f.slotId))
    if (i < 0) i = free.findIndex((f) => willing(f.slotId))
    if (i < 0) i = 0
    const off = free.splice(i, 1)[0]!
    swaps.push({
      off: off.playerId,
      offSlot: off.slotId,
      on: on.playerId,
      onSlot: off.slotId,
    })
    matched++
  }

  return {
    swaps,
    moves: [],
    offOnly: free,
    onOnly: ons.slice(matched),
  }
}

export function isSubDue(sub: SubPlan): boolean {
  return sub.swaps.length > 0 || sub.offOnly.length > 0 || sub.onOnly.length > 0
}
