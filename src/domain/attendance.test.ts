import { describe, expect, it } from 'vitest'
import {
  arrivalMarks,
  departureMarks,
  normaliseAttendance,
  reconcileAttendance,
} from './attendance'
import { fairShareSec } from './fairness'
import { DEFAULT_RULES, gameLengthSec, type Attendance, type Player } from './types'

const RULES = { ...DEFAULT_RULES } // 4 × 10 min
const END = gameLengthSec(RULES) // 2400s
const Q2 = 600
const Q4_START = 1800

function player(id: string, active = true): Player {
  return {
    id,
    teamId: 't',
    firstName: id,
    active,
    gk: 'willing',
    preferredGroups: [],
    avoidGroups: [],
    createdAt: 0,
  }
}

describe('normaliseAttendance', () => {
  it('keeps the arrival window for a late player', () => {
    const a = normaliseAttendance(
      { playerId: 'p', status: 'late', availableFromSec: Q2 },
      RULES,
    )
    expect(a.status).toBe('late')
    expect(a.availableFromSec).toBe(Q2)
    expect(a.availableUntilSec).toBeUndefined()
  })

  it('drops a stale window when a player is switched back to available', () => {
    // The bug this prevents: a leftover arrival time silently shrinking someone's
    // fair share, with nothing on screen to show why.
    const a = normaliseAttendance(
      { playerId: 'p', status: 'available', availableFromSec: Q2 },
      RULES,
    )
    expect(a.availableFromSec).toBeUndefined()
    expect(a.availableUntilSec).toBeUndefined()
  })

  it('treats arriving at kick-off as simply available', () => {
    const a = normaliseAttendance(
      { playerId: 'p', status: 'late', availableFromSec: 0 },
      RULES,
    )
    expect(a.status).toBe('available')
    expect(a.availableFromSec).toBeUndefined()
  })

  it('treats leaving at full time as simply available', () => {
    const a = normaliseAttendance(
      { playerId: 'p', status: 'leaveEarly', availableUntilSec: END },
      RULES,
    )
    expect(a.status).toBe('available')
  })

  it('clamps a window that runs past the end of the game', () => {
    const a = normaliseAttendance(
      { playerId: 'p', status: 'late', availableFromSec: END + 5000 },
      RULES,
    )
    expect(a.availableFromSec).toBe(END)
  })

  it('treats an inverted window as absent rather than a negative share', () => {
    const a = normaliseAttendance(
      {
        playerId: 'p',
        status: 'limited',
        availableFromSec: 1800,
        availableUntilSec: 600,
      },
      RULES,
    )
    expect(a.status).toBe('absent')
  })

  it('preserves a note across normalisation', () => {
    const a = normaliseAttendance(
      { playerId: 'p', status: 'late', availableFromSec: Q2, note: 'dentist' },
      RULES,
    )
    expect(a.note).toBe('dentist')
  })
})

describe('reconcileAttendance', () => {
  const roster = [player('a'), player('b'), player('c')]

  it('defaults a newly added player to available', () => {
    const stored: Attendance[] = [{ playerId: 'a', status: 'absent' }]
    const out = reconcileAttendance(stored, roster)
    expect(out).toHaveLength(3)
    expect(out.find((x) => x.playerId === 'a')?.status).toBe('absent')
    expect(out.find((x) => x.playerId === 'c')?.status).toBe('available')
  })

  it('drops players who left the roster', () => {
    const stored: Attendance[] = [
      { playerId: 'a', status: 'available' },
      { playerId: 'gone', status: 'available' },
    ]
    const out = reconcileAttendance(stored, roster)
    expect(out.map((x) => x.playerId)).toEqual(['a', 'b', 'c'])
  })

  it('ignores inactive players', () => {
    const out = reconcileAttendance([], [player('a'), player('inactive', false)])
    expect(out.map((x) => x.playerId)).toEqual(['a'])
  })

  it('keeps a late arrival window intact', () => {
    const stored: Attendance[] = [
      { playerId: 'b', status: 'late', availableFromSec: Q2 },
    ]
    const out = reconcileAttendance(stored, roster)
    expect(out.find((x) => x.playerId === 'b')?.availableFromSec).toBe(Q2)
  })
})

describe('period marks', () => {
  it('offers arrivals at the start of every period after the first', () => {
    expect(arrivalMarks(RULES)).toEqual([
      { label: 'Q2', sec: 600 },
      { label: 'Q3', sec: 1200 },
      { label: 'Q4', sec: 1800 },
    ])
  })

  it('offers departures at the end of every period but the last', () => {
    expect(departureMarks(RULES)).toEqual([
      { label: 'Q1', sec: 600 },
      { label: 'Q2', sec: 1200 },
      { label: 'Q3', sec: 1800 },
    ])
  })
})

describe('attendance feeding fair share', () => {
  it('gives a player arriving for the last quarter a quarter-sized share', () => {
    const attendance: Attendance[] = [
      ...Array.from({ length: 9 }, (_, i) => ({
        playerId: `p${i}`,
        status: 'available' as const,
      })),
      normaliseAttendance(
        { playerId: 'late', status: 'late', availableFromSec: Q4_START },
        RULES,
      ),
    ]
    const share = fairShareSec(RULES, attendance)
    // Final quarter only, pool of 10: 600 × 7/10
    expect(share.get('late')).toBeCloseTo(420, 6)
    const total = [...share.values()].reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(RULES.playersOnField * END, 4)
  })
})
