import type { Attendance, GameRules, Player } from './types'
import { gameLengthSec } from './types'

/**
 * Attendance rules, kept pure and free of storage so they can be tested.
 *
 * The invariant worth protecting: a status always carries exactly the window it
 * implies. A stale arrival time left behind on a player switched back to
 * "here" would quietly distort every plan afterwards, and nothing on screen
 * would show it.
 */
export function normaliseAttendance(a: Attendance, rules: GameRules): Attendance {
  const end = gameLengthSec(rules)
  const out: Attendance = { playerId: a.playerId, status: a.status }
  if (a.note) out.note = a.note

  if (a.status === 'late' || a.status === 'limited') {
    out.availableFromSec = clamp(a.availableFromSec ?? 0, 0, end)
  }
  if (a.status === 'leaveEarly' || a.status === 'limited') {
    out.availableUntilSec = clamp(a.availableUntilSec ?? end, 0, end)
  }

  // A "late" arrival at kick-off is just available; recording a zero-length
  // window would be a lie the planner then has to interpret.
  if (out.status === 'late' && (out.availableFromSec ?? 0) <= 0) {
    return { playerId: a.playerId, status: 'available' }
  }
  if (out.status === 'leaveEarly' && (out.availableUntilSec ?? end) >= end) {
    return { playerId: a.playerId, status: 'available' }
  }

  // An inverted window means nobody plays; treat it as absent rather than
  // letting fair share silently divide by a pool that excludes them anyway.
  if (
    out.availableFromSec !== undefined &&
    out.availableUntilSec !== undefined &&
    out.availableUntilSec <= out.availableFromSec
  ) {
    return { playerId: a.playerId, status: 'absent' }
  }

  return out
}

/**
 * Reconcile stored attendance against the live roster.
 *
 * A player added to the team after a game was created still appears, defaulting
 * to available — otherwise they are silently missing from the plan. Players
 * removed from the roster drop out.
 */
export function reconcileAttendance(
  stored: Attendance[],
  roster: Player[],
): Attendance[] {
  const byId = new Map(stored.map((a) => [a.playerId, a]))
  return roster
    .filter((p) => p.active)
    .map<Attendance>(
      (p) => byId.get(p.id) ?? { playerId: p.id, status: 'available' as const },
    )
}

export interface PeriodMark {
  label: string
  sec: number
}

/** "From Q2" beats a seconds field when you are standing in a car park. */
export function arrivalMarks(rules: GameRules): PeriodMark[] {
  const per = rules.periodMinutes * 60
  const out: PeriodMark[] = []
  for (let p = 2; p <= rules.periodCount; p++) {
    out.push({ label: `Q${p}`, sec: (p - 1) * per })
  }
  return out
}

export function departureMarks(rules: GameRules): PeriodMark[] {
  const per = rules.periodMinutes * 60
  const out: PeriodMark[] = []
  for (let p = 1; p < rules.periodCount; p++) {
    out.push({ label: `Q${p}`, sec: p * per })
  }
  return out
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
