import type { Attendance, GameRules, ID } from './types'
import { gameLengthSec } from './types'

/**
 * Fair share.
 *
 * A player who arrives late gets an even share of what remains — not a debt
 * the rest of the team pays back. So a target is not a flat team average; it
 * is the available share integrated over the window they were actually there.
 *
 *   fairShare(p) = Σ over intervals where p is available:
 *                    duration × min(playersOnField, available) / available
 *
 * Goalkeeper minutes count at full rate, so this is the whole calculation.
 * There is no second, weighted ledger running alongside it.
 */

export interface AvailabilityWindow {
  playerId: ID
  fromSec: number
  untilSec: number
}

/** Attendance rows turned into concrete [from, until) windows. Absent players drop out. */
export function availabilityWindows(
  rules: GameRules,
  attendance: Attendance[],
): AvailabilityWindow[] {
  const end = gameLengthSec(rules)
  const out: AvailabilityWindow[] = []
  for (const a of attendance) {
    if (a.status === 'absent') continue
    const fromSec = clamp(a.availableFromSec ?? 0, 0, end)
    const untilSec = clamp(a.availableUntilSec ?? end, 0, end)
    if (untilSec > fromSec) out.push({ playerId: a.playerId, fromSec, untilSec })
  }
  return out
}

/**
 * Split the game at every window boundary, so that within each interval the
 * set of available players is constant. Exact, and cheap — a game has a
 * handful of boundaries at most.
 */
export function availabilityIntervals(
  rules: GameRules,
  windows: AvailabilityWindow[],
): { startSec: number; endSec: number; available: ID[] }[] {
  const end = gameLengthSec(rules)
  const cuts = new Set<number>([0, end])
  for (const w of windows) {
    cuts.add(w.fromSec)
    cuts.add(w.untilSec)
  }
  const points = [...cuts].filter((c) => c >= 0 && c <= end).sort((a, b) => a - b)

  const out: { startSec: number; endSec: number; available: ID[] }[] = []
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!
    const b = points[i + 1]!
    if (b <= a) continue
    const available = windows
      .filter((w) => w.fromSec <= a && w.untilSec >= b)
      .map((w) => w.playerId)
    out.push({ startSec: a, endSec: b, available })
  }
  return out
}

/**
 * Target seconds per player for one game.
 *
 * Short-handed is handled by `min(playersOnField, n) / n`: if only six players
 * turn up to a 7v7 game, everyone available plays the whole time and nobody is
 * recorded as owed minutes that did not exist.
 */
export function fairShareSec(rules: GameRules, attendance: Attendance[]): Map<ID, number> {
  const windows = availabilityWindows(rules, attendance)
  const share = new Map<ID, number>()
  for (const w of windows) share.set(w.playerId, 0)

  for (const iv of availabilityIntervals(rules, windows)) {
    const n = iv.available.length
    if (n === 0) continue
    const duration = iv.endSec - iv.startSec
    const each = (duration * Math.min(rules.playersOnField, n)) / n
    for (const id of iv.available) share.set(id, (share.get(id) ?? 0) + each)
  }
  return share
}

/**
 * Fair share broken down per shift, so the planner can ask "who is owed time
 * *by now*" rather than only at full time. Summing these gives exactly
 * `fairShareSec`, which is asserted in the tests.
 */
export function fairShareByShift(
  rules: GameRules,
  attendance: Attendance[],
  shifts: ShiftSlice[],
): Map<ID, number>[] {
  const windows = availabilityWindows(rules, attendance)
  const intervals = availabilityIntervals(rules, windows)

  return shifts.map((s) => {
    const inc = new Map<ID, number>()
    for (const iv of intervals) {
      const a = Math.max(iv.startSec, s.startSec)
      const b = Math.min(iv.endSec, s.endSec)
      if (b <= a) continue
      const n = iv.available.length
      if (n === 0) continue
      const each = ((b - a) * Math.min(rules.playersOnField, n)) / n
      for (const id of iv.available) inc.set(id, (inc.get(id) ?? 0) + each)
    }
    return inc
  })
}

// ---------------------------------------------------------------- shift grid

export interface ShiftSlice {
  index: number
  period: number
  startSec: number
  endSec: number
}

/**
 * Substitution boundaries for the whole game.
 *
 * A shift never spans a period boundary, and each period is divided into
 * equal slices closest to the target cadence — so a 10-minute quarter with a
 * 3-minute target becomes three shifts of 3:20 rather than 3, 3, 3 and a
 * useless 1-minute tail.
 */
export function buildShiftGrid(rules: GameRules): ShiftSlice[] {
  const periodSec = rules.periodMinutes * 60
  const target = Math.max(30, rules.shiftMinutes * 60)
  const perPeriod = Math.max(1, Math.round(periodSec / target))

  const out: ShiftSlice[] = []
  let index = 0
  for (let period = 1; period <= rules.periodCount; period++) {
    const base = (period - 1) * periodSec
    for (let k = 0; k < perPeriod; k++) {
      out.push({
        index: index++,
        period,
        startSec: base + Math.round((k * periodSec) / perPeriod),
        endSec: base + Math.round(((k + 1) * periodSec) / perPeriod),
      })
    }
  }
  return out
}

/** Players whose window covers the majority of a shift. Used by the planner. */
export function eligibleDuring(
  windows: AvailabilityWindow[],
  shift: ShiftSlice,
): Set<ID> {
  const mid = (shift.startSec + shift.endSec) / 2
  const out = new Set<ID>()
  for (const w of windows) {
    if (w.fromSec <= mid && w.untilSec >= mid) out.add(w.playerId)
  }
  return out
}

// ---------------------------------------------------------------- formatting

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** 128 -> "2:08". Always mm:ss, for tabular alignment. */
export function mmss(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec))
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/** 1280 -> "21m". For dense reporting where seconds are noise. */
export function minutes(totalSec: number): string {
  return `${Math.round(totalSec / 60)}m`
}

/** Signed, for deficits: +4:20 owed, -1:05 over. */
export function signedMmss(totalSec: number): string {
  const sign = totalSec < 0 ? '−' : '+'
  return sign + mmss(Math.abs(totalSec))
}
