import { describe, expect, it } from 'vitest'
import {
  currentShiftIndex,
  deriveLive,
  diffToPlan,
  isSubDue,
  planFieldChange,
  secondsUntilShift,
} from './live'
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

  it('never advances the period on its own', () => {
    // Soccer periods do not end on a timer. A ten-minute quarter that has run
    // for twelve is still the first quarter, still running, until a human says
    // otherwise.
    const s = derive(log([0, { type: 'PERIOD_START', period: 1 }]), 720)
    expect(s.period).toBe(1)
    expect(s.status).toBe('running')
    expect(s.periodElapsedSec).toBeCloseTo(720, 6)
  })

  it('keeps counting past the nominal period length', () => {
    const s = derive(
      log(
        [0, { type: 'PERIOD_START', period: 1 }],
        [660, { type: 'PERIOD_END', period: 1 }],
      ),
      700,
    )
    // Eleven minutes actually played in a ten-minute quarter, and all of it counts.
    expect(s.cumulativeSec).toBeCloseTo(660, 6)
    expect(s.status).toBe('break')
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

  it('leaves the players staying on exactly where they are', () => {
    // The plan wants these two to trade positions. Nobody is coming off, so
    // there is nothing to do — marching children across the pitch to satisfy a
    // chart is disruptive and buys nothing.
    const now = { lb: 'a', cm: 'b' }
    const next = { lb: 'b', cm: 'a' }
    const sub = diffToPlan(now, next)
    expect(sub.swaps).toHaveLength(0)
    expect(sub.moves).toHaveLength(0)
    expect(sub.offOnly).toHaveLength(0)
    expect(sub.onOnly).toHaveLength(0)
  })

  it('puts the player coming on into the position just vacated', () => {
    const now = { gk: 'k', lb: 'a', cm: 'b', st: 'c' }
    // The plan wants 'x' at cm, but 'a' is the one coming off at lb.
    const next = { gk: 'k', cm: 'x', st: 'c', lb: 'b' }
    const sub = diffToPlan(now, next)
    expect(sub.swaps).toHaveLength(1)
    expect(sub.swaps[0]!.off).toBe('a')
    expect(sub.swaps[0]!.on).toBe('x')
    // Takes the vacated shirt, not the planned one.
    expect(sub.swaps[0]!.onSlot).toBe('lb')
    // And 'b' is not marched from cm to lb.
    expect(sub.moves).toHaveLength(0)
  })

  it('prefers the planned position when it is one of the ones opening up', () => {
    const now = { lb: 'a', st: 'c' }
    const next = { lb: 'x', st: 'y' }
    const sub = diffToPlan(now, next)
    const x = sub.swaps.find((w) => w.on === 'x')
    expect(x?.onSlot).toBe('lb')
  })

  it('avoids handing someone a position they will not play', () => {
    const slots = FORMATION.slots
    const now = { lb: 'a', st: 'c' } // defence and attack both opening up
    const next = { lb: 'x', st: 'y' }
    const avoids = new Map([['x', ['DEF' as const]]])
    const sub = diffToPlan(now, next, { slots, avoids })
    expect(sub.swaps.find((w) => w.on === 'x')?.onSlot).toBe('st')
    expect(sub.swaps.find((w) => w.on === 'y')?.onSlot).toBe('lb')
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

describe('planFieldChange', () => {
  const FIELD = { gk: 'zoe', lb: 'a', rb: 'b', lm: 'c', cm: 'd', rm: 'e', st: 'f' }

  it('trades places when both players are already on', () => {
    // The case that had no answer before: two outfielders switching positions.
    const c = planFieldChange(FIELD, 'cm', 'a')
    expect(c.kind).toBe('swap')
    expect(c.events).toEqual([
      { type: 'MOVE', playerId: 'a', fromSlotId: 'lb', toSlotId: 'cm' },
      { type: 'MOVE', playerId: 'd', fromSlotId: 'cm', toSlotId: 'lb' },
    ])
    expect(c.nextField['cm']).toBe('a')
    expect(c.nextField['lb']).toBe('d')
  })

  it('keeps the same eleven on the field after a trade', () => {
    const c = planFieldChange(FIELD, 'cm', 'a')
    expect(new Set(Object.values(c.nextField))).toEqual(
      new Set(Object.values(FIELD)),
    )
    expect(Object.keys(c.nextField).sort()).toEqual(Object.keys(FIELD).sort())
  })

  it('never emits OFF for a trade, so nobody loses a minute', () => {
    const c = planFieldChange(FIELD, 'cm', 'a')
    expect(c.events.some((e) => e.type === 'OFF')).toBe(false)
    expect(c.events.some((e) => e.type === 'ON')).toBe(false)
  })

  it('substitutes when the incoming player is on the bench', () => {
    const c = planFieldChange(FIELD, 'st', 'sub1')
    expect(c.kind).toBe('sub')
    expect(c.events).toEqual([
      { type: 'OFF', playerId: 'f', slotId: 'st' },
      { type: 'ON', playerId: 'sub1', slotId: 'st' },
    ])
    expect(c.nextField['st']).toBe('sub1')
  })

  it('fills an empty position without taking anyone off', () => {
    const short = { ...FIELD }
    delete (short as Record<string, string>)['st']
    const c = planFieldChange(short, 'st', 'sub1')
    expect(c.kind).toBe('fill')
    expect(c.events).toEqual([{ type: 'ON', playerId: 'sub1', slotId: 'st' }])
  })

  it('moves a player into a gap rather than duplicating them', () => {
    const short = { ...FIELD }
    delete (short as Record<string, string>)['st']
    const c = planFieldChange(short, 'st', 'a')
    expect(c.kind).toBe('swap')
    expect(c.nextField['st']).toBe('a')
    expect(c.nextField['lb']).toBeUndefined()
  })

  it('does nothing when the player is already there', () => {
    const c = planFieldChange(FIELD, 'cm', 'd')
    expect(c.kind).toBe('none')
    expect(c.events).toHaveLength(0)
  })

  it('can put an outfielder in goal, sending the keeper out to their shirt', () => {
    const c = planFieldChange(FIELD, 'gk', 'b')
    expect(c.kind).toBe('swap')
    expect(c.nextField['gk']).toBe('b')
    expect(c.nextField['rb']).toBe('zoe')
  })
})

describe('diffToPlan — the goal', () => {
  const slots = FORMATION.slots
  const FULL = { gk: 'zoe', lb: 'a', rb: 'b', lm: 'c', cm: 'd', rm: 'e', st: 'f' }

  it('actually changes the keeper when the plan says so', () => {
    // The bug this guards: treating the goal as an ordinary shirt let the
    // incoming keeper be placed outfield while the old one stayed in goal all
    // game, with the sub sheet reporting a perfectly normal-looking swap.
    const next = { ...FULL, gk: 'mia', rb: 'zoe' }
    const sub = diffToPlan(FULL, next, { slots })
    expect(sub.keeper).toBeDefined()
    expect(sub.keeper!.off).toBe('zoe')
    expect(sub.keeper!.on).toBe('mia')
  })

  it('trades places when the new keeper is already on the field', () => {
    const next = { ...FULL, gk: 'b', rb: 'zoe' }
    const sub = diffToPlan(FULL, next, { slots })
    expect(sub.keeper).toEqual({
      off: 'zoe',
      on: 'b',
      gkSlotId: 'gk',
      tradeSlotId: 'rb',
    })
    // Nobody else is disturbed by a keeper change.
    expect(sub.swaps).toHaveLength(0)
    expect(sub.offOnly).toHaveLength(0)
    expect(sub.onOnly).toHaveLength(0)
  })

  it('brings a keeper off the bench without a trade', () => {
    const next = { ...FULL, gk: 'mia' }
    const sub = diffToPlan(FULL, next, { slots })
    expect(sub.keeper).toEqual({ off: 'zoe', on: 'mia', gkSlotId: 'gk' })
    expect(sub.keeper!.tradeSlotId).toBeUndefined()
    expect(sub.swaps).toHaveLength(0)
  })

  it('lets the outgoing keeper come back on outfield in the same change', () => {
    // Mia takes the gloves, Zoe goes to the bench, and the plan wants Zoe at
    // right back in place of b. That is one keeper change plus one swap.
    const next = { ...FULL, gk: 'mia', rb: 'zoe' }
    const sub = diffToPlan(FULL, next, { slots })
    expect(sub.keeper!.on).toBe('mia')
    expect(sub.swaps).toHaveLength(1)
    expect(sub.swaps[0]!.off).toBe('b')
    expect(sub.swaps[0]!.on).toBe('zoe')
    expect(sub.swaps[0]!.onSlot).toBe('rb')
  })

  it('says nothing about the goal when the keeper is unchanged', () => {
    const next = { ...FULL, st: 'z' }
    const sub = diffToPlan(FULL, next, { slots })
    expect(sub.keeper).toBeUndefined()
    expect(sub.swaps).toHaveLength(1)
  })

  it('counts a keeper change as a substitution being due', () => {
    const next = { ...FULL, gk: 'mia', rb: 'zoe' }
    expect(isSubDue(diffToPlan(FULL, next, { slots }))).toBe(true)
  })

  describe('during play the goal is left alone', () => {
    it('never proposes a keeper change at a stoppage', () => {
      const next = { ...FULL, gk: 'mia', rb: 'zoe' }
      const sub = diffToPlan(FULL, next, { slots, ignoreKeeper: true })
      expect(sub.keeper).toBeUndefined()
      expect(isSubDue(sub)).toBe(false)
    })

    it('proposes nothing at all when the plan wants a different keeper', () => {
      // The outfield half of that shift was planned around the new keeper being
      // on, so applying it alone would leave the team a player short.
      const next = { ...FULL, gk: 'mia', rb: 'zoe', st: 'newcomer' }
      const sub = diffToPlan(FULL, next, { slots, ignoreKeeper: true })
      expect(sub.swaps).toHaveLength(0)
      expect(sub.offOnly).toHaveLength(0)
      expect(sub.onOnly).toHaveLength(0)
    })

    it('still proposes ordinary outfield swaps', () => {
      const next = { ...FULL, st: 'newcomer' }
      const sub = diffToPlan(FULL, next, { slots, ignoreKeeper: true })
      expect(sub.keeper).toBeUndefined()
      expect(sub.swaps).toHaveLength(1)
      expect(sub.swaps[0]!.off).toBe('f')
      expect(sub.swaps[0]!.on).toBe('newcomer')
    })

    it('does not drag the keeper out of goal to fill an outfield slot', () => {
      const next = { ...FULL, st: 'newcomer' }
      const sub = diffToPlan(FULL, next, { slots, ignoreKeeper: true })
      const moved = [...sub.swaps.map((w) => w.on), ...sub.onOnly.map((o) => o.playerId)]
      expect(moved).not.toContain('zoe')
    })
  })
})
