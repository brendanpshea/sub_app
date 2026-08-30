import { describe, expect, it } from 'vitest'
import { currentShiftIndex, deriveLive, diffToPlan, secondsUntilShift } from './live'
import { BUILT_IN_FORMATIONS } from './formations'
import { buildShiftGrid } from './fairness'
import { DEFAULT_RULES, type GameEvent, type GameEventBody } from './types'

const FORMATION = BUILT_IN_FORMATIONS[0]! // 2-3-1: gk, lb, rb, lm, cm, rm, st
const RULES = { ...DEFAULT_RULES }
const GRID = buildShiftGrid(RULES) // 12 shifts of 200s, 3 per period
const T0 = 1_700_000_000_000

/** Build an event log from [offsetSeconds, body] pairs. */
function log(...rows: [number, GameEventBody][]): GameEvent[] {
  return rows.map(([offset, body], i) => ({
    id: `e${i}`,
    gameId: 'g',
    seq: i + 1,
    wallAt: T0 + offset * 1000,
    t: 0,
    body,
  }))
}

function at(seconds: number): number {
  return T0 + seconds * 1000
}

function derive(events: GameEvent[], nowSec: number) {
  return deriveLive(events, RULES, FORMATION, at(nowSec))
}

describe('clock', () => {
  it('starts at zero before kick-off', () => {
    const s = derive([], 500)
    expect(s.status).toBe('pre')
    expect(s.period).toBe(0)
    expect(s.cumulativeSec).toBe(0)
    expect(s.periodElapsedSec).toBe(0)
  })

  it('keeps running while the phone is in a pocket', () => {
    // The whole reason the clock is derived from timestamps rather than ticked.
    const s = derive(log([0, { type: 'PERIOD_START', period: 1 }]), 600)
    expect(s.running).toBe(true)
    expect(s.cumulativeSec).toBeCloseTo(600, 6)
    expect(s.periodElapsedSec).toBeCloseTo(600, 6)
  })

  it('stops counting while paused', () => {
    const s = derive(
      log([0, { type: 'PERIOD_START', period: 1 }], [60, { type: 'CLOCK_PAUSE' }]),
      300,
    )
    expect(s.running).toBe(false)
    expect(s.status).toBe('paused')
    expect(s.cumulativeSec).toBeCloseTo(60, 6)
  })

  it('resumes from where it paused', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [60, { type: 'CLOCK_PAUSE' }],
        [300, { type: 'CLOCK_RESUME' }],
      ),
      360,
    )
    expect(s.cumulativeSec).toBeCloseTo(120, 6)
  })

  it('does not count the interval between periods', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [600, { type: 'PERIOD_END', period: 1 }],
        [900, { type: 'PERIOD_START', period: 2 }],
      ),
      960,
    )
    expect(s.period).toBe(2)
    expect(s.cumulativeSec).toBeCloseTo(660, 6)
    expect(s.periodElapsedSec).toBeCloseTo(60, 6)
  })

  it('holds still during a break', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [600, { type: 'PERIOD_END', period: 1 }],
      ),
      900,
    )
    expect(s.status).toBe('break')
    expect(s.cumulativeSec).toBeCloseTo(600, 6)
  })

  it('goes final after the last period', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 4 }],
        [600, { type: 'PERIOD_END', period: 4 }],
      ),
      700,
    )
    expect(s.status).toBe('final')
  })

  it('applies a clock correction without losing time already played', () => {
    // "We started 45 seconds late."
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [10, { type: 'CLOCK_ADJUST', deltaSec: 45 }],
      ),
      20,
    )
    expect(s.cumulativeSec).toBeCloseTo(65, 6)
  })
})

describe('minutes', () => {
  it('counts a stint from ON to OFF', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [0, { type: 'ON', playerId: 'p1', slotId: 'st' }],
        [120, { type: 'OFF', playerId: 'p1', slotId: 'st' }],
      ),
      300,
    )
    expect(s.playedSec.get('p1')).toBeCloseTo(120, 6)
    expect(s.onField['st']).toBeUndefined()
  })

  it('counts an open stint up to now', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [30, { type: 'ON', playerId: 'p1', slotId: 'st' }],
      ),
      150,
    )
    expect(s.playedSec.get('p1')).toBeCloseTo(120, 6)
    expect(s.onField['st']).toBe('p1')
  })

  it('excludes paused time from a stint', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [0, { type: 'ON', playerId: 'p1', slotId: 'st' }],
        [60, { type: 'CLOCK_PAUSE' }],
        [600, { type: 'CLOCK_RESUME' }],
      ),
      660,
    )
    expect(s.playedSec.get('p1')).toBeCloseTo(120, 6)
  })

  it('carries a stint across the interval without counting the break', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [0, { type: 'ON', playerId: 'p1', slotId: 'st' }],
        [600, { type: 'PERIOD_END', period: 1 }],
        [900, { type: 'PERIOD_START', period: 2 }],
      ),
      960,
    )
    expect(s.playedSec.get('p1')).toBeCloseTo(660, 6)
  })

  it('credits goalkeeping separately but at full rate', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [0, { type: 'ON', playerId: 'k', slotId: 'gk' }],
      ),
      300,
    )
    expect(s.playedSec.get('k')).toBeCloseTo(300, 6)
    expect(s.gkSec.get('k')).toBeCloseTo(300, 6)
    expect(s.gkPeriods.get('k')).toEqual(new Set([1]))
  })

  it('treats a position change as one unbroken stint', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [0, { type: 'ON', playerId: 'p1', slotId: 'lb' }],
        [120, { type: 'MOVE', playerId: 'p1', fromSlotId: 'lb', toSlotId: 'cm' }],
      ),
      240,
    )
    expect(s.playedSec.get('p1')).toBeCloseTo(240, 6)
    expect(s.secByGroup.get('p1')?.DEF).toBeCloseTo(120, 6)
    expect(s.secByGroup.get('p1')?.MID).toBeCloseTo(120, 6)
    expect(s.onField['lb']).toBeUndefined()
    expect(s.onField['cm']).toBe('p1')
  })
})

describe('undo', () => {
  it('puts a player back on when their substitution is voided', () => {
    const events = log(
      [0, { type: 'PERIOD_START', period: 1 }],
      [0, { type: 'ON', playerId: 'p1', slotId: 'st' }],
      [120, { type: 'OFF', playerId: 'p1', slotId: 'st' }],
    )
    const voided: GameEvent[] = [
      ...events,
      {
        id: 'v',
        gameId: 'g',
        seq: 99,
        wallAt: at(130),
        t: 0,
        body: { type: 'VOID', seq: 3 },
      },
    ]
    const s = derive(voided, 240)
    expect(s.onField['st']).toBe('p1')
    expect(s.playedSec.get('p1')).toBeCloseTo(240, 6)
  })
})

describe('stats', () => {
  it('tallies goals, assists and saves', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [30, { type: 'GOAL', playerId: 'p1', assistId: 'p2' }],
        [60, { type: 'GOAL', playerId: 'p1' }],
        [90, { type: 'SAVE', playerId: 'k' }],
      ),
      120,
    )
    expect(s.goalCount).toBe(2)
    expect(s.goals.get('p1')).toBe(2)
    expect(s.assists.get('p2')).toBe(1)
    expect(s.saves.get('k')).toBe(1)
  })
})

describe('currentShiftIndex', () => {
  it('finds the shift for a time inside a period', () => {
    expect(currentShiftIndex(GRID, RULES, 1, 0)).toBe(0)
    expect(currentShiftIndex(GRID, RULES, 1, 199)).toBe(0)
    expect(currentShiftIndex(GRID, RULES, 1, 200)).toBe(1)
    expect(currentShiftIndex(GRID, RULES, 1, 450)).toBe(2)
  })

  it('stays in the last shift when the referee plays on', () => {
    // Eleven minutes in a ten-minute quarter must not spill into Q2's shifts.
    expect(currentShiftIndex(GRID, RULES, 1, 700)).toBe(2)
  })

  it('is period-relative, not cumulative', () => {
    expect(currentShiftIndex(GRID, RULES, 2, 0)).toBe(3)
    expect(currentShiftIndex(GRID, RULES, 4, 450)).toBe(11)
  })
})

describe('secondsUntilShift', () => {
  it('counts down to the boundary and then goes negative', () => {
    const shift = GRID[1]! // period 1, starts at 200s
    expect(secondsUntilShift(shift, RULES, 140)).toBe(60)
    expect(secondsUntilShift(shift, RULES, 200)).toBe(0)
    expect(secondsUntilShift(shift, RULES, 260)).toBe(-60)
  })
})

describe('diffToPlan', () => {
  it('pairs players coming off with players going on', () => {
    const now = { gk: 'k', lb: 'a', rb: 'b', lm: 'c', cm: 'd', rm: 'e', st: 'f' }
    const next = { gk: 'k', lb: 'x', rb: 'b', lm: 'c', cm: 'd', rm: 'e', st: 'y' }
    const sub = diffToPlan(now, next)
    expect(sub.swaps).toHaveLength(2)
    expect(sub.swaps.map((s) => s.off).sort()).toEqual(['a', 'f'])
    expect(sub.swaps.map((s) => s.on).sort()).toEqual(['x', 'y'])
    expect(sub.offOnly).toHaveLength(0)
    expect(sub.onOnly).toHaveLength(0)
  })

  it('reports a position change as a move, not a substitution', () => {
    const now = { lb: 'a', cm: 'b' }
    const next = { lb: 'b', cm: 'a' }
    const sub = diffToPlan(now, next)
    expect(sub.swaps).toHaveLength(0)
    expect(sub.moves).toHaveLength(2)
  })

  it('says nothing when the field already matches the plan', () => {
    const now = { gk: 'k', st: 'f' }
    const sub = diffToPlan(now, { ...now })
    expect(sub.swaps).toHaveLength(0)
    expect(sub.moves).toHaveLength(0)
  })

  it('handles going a player short', () => {
    const sub = diffToPlan({ lb: 'a', cm: 'b' }, { lb: 'a' })
    expect(sub.offOnly).toEqual([{ playerId: 'b', slotId: 'cm' }])
  })
})
