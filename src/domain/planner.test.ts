import { describe, expect, it } from 'vitest'
import { generatePlan, replanFrom, type PlannerInput } from './planner'
import { BUILT_IN_FORMATIONS } from './formations'
import { buildShiftGrid } from './fairness'
import {
  DEFAULT_RULES,
  gameLengthSec,
  type Attendance,
  type GameRules,
  type PlannedShift,
  type Player,
} from './types'

const FORMATION = BUILT_IN_FORMATIONS[0]! // 2-3-1
const RULES: GameRules = { ...DEFAULT_RULES, balance: 0 } // deterministic-ish
const END = gameLengthSec(RULES) // 2400s
const GRID = buildShiftGrid(RULES) // 12 shifts of 200s

function player(id: string, patch: Partial<Player> = {}): Player {
  return {
    id,
    teamId: 't',
    firstName: id,
    active: true,
    gk: 'willing',
    preferredGroups: [],
    avoidGroups: [],
    createdAt: 0,
    ...patch,
  }
}

function squad(n: number, patch: Partial<Player> = {}): Player[] {
  return Array.from({ length: n }, (_, i) => player(`p${i + 1}`, patch))
}

function allHere(roster: Player[]): Attendance[] {
  return roster.map((p) => ({ playerId: p.id, status: 'available' as const }))
}

function input(roster: Player[], patch: Partial<PlannerInput> = {}): PlannerInput {
  return {
    rules: RULES,
    formation: FORMATION,
    roster,
    attendance: allHere(roster),
    seed: 12345,
    ...patch,
  }
}

function onField(shift: PlannedShift): string[] {
  return FORMATION.slots
    .map((s) => shift.assignments[s.id])
    .filter((x): x is string => !!x)
}

describe('generatePlan — structural integrity', () => {
  const roster = squad(10)
  const plan = generatePlan(input(roster))

  it('fills every slot in every shift', () => {
    expect(plan.shifts).toHaveLength(GRID.length)
    for (const s of plan.shifts) {
      expect(Object.keys(s.assignments)).toHaveLength(FORMATION.slots.length)
    }
    expect(plan.warnings).toEqual([])
  })

  it('never puts the same player in two slots at once', () => {
    for (const s of plan.shifts) {
      const ids = onField(s)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('assigns exactly the available player-seconds', () => {
    const total = [...plan.assigned.values()].reduce((a, b) => a + b, 0)
    expect(total).toBe(RULES.playersOnField * END)
  })

  it('is deterministic for a given seed', () => {
    const a = generatePlan(input(roster, { seed: 999 }))
    const b = generatePlan(input(roster, { seed: 999 }))
    expect(a.shifts).toEqual(b.shifts)
  })

  it('produces a different chart for a different seed', () => {
    const a = generatePlan(input(roster, { seed: 1, rules: { ...RULES, balance: 0.5 } }))
    const b = generatePlan(input(roster, { seed: 2, rules: { ...RULES, balance: 0.5 } }))
    expect(a.shifts).not.toEqual(b.shifts)
  })
})

describe('generatePlan — fairness', () => {
  it('lands everyone within one shift of their fair share', () => {
    const roster = squad(10)
    const plan = generatePlan(input(roster))
    // Assignments are quantised to whole shifts (200s), so one shift is the floor.
    expect(plan.spreadSec).toBeLessThanOrEqual(210)
  })

  it('holds up across roster sizes', () => {
    for (const n of [8, 9, 10, 11, 12, 14]) {
      const roster = squad(n)
      const plan = generatePlan(input(roster))
      expect(plan.spreadSec, `roster of ${n}`).toBeLessThanOrEqual(220)
      const total = [...plan.assigned.values()].reduce((a, b) => a + b, 0)
      expect(total, `roster of ${n}`).toBe(RULES.playersOnField * END)
    }
  })

  it('gives a late arrival an even share of what remains', () => {
    const roster = squad(10)
    const attendance: Attendance[] = [
      ...allHere(roster).slice(0, 9),
      { playerId: 'p10', status: 'late', availableFromSec: END / 2 },
    ]
    const plan = generatePlan(input(roster, { attendance }))

    // Never on the field before they arrive.
    for (const s of plan.shifts) {
      if (s.endSec <= END / 2) expect(onField(s)).not.toContain('p10')
    }
    // Second half only, pool of ten: 1200 × 7/10 = 840s.
    expect(plan.target.get('p10')).toBeCloseTo(840, 6)
    expect(Math.abs((plan.assigned.get('p10') ?? 0) - 840)).toBeLessThanOrEqual(210)
  })

  it('never schedules a player after they leave', () => {
    const roster = squad(10)
    const attendance: Attendance[] = [
      ...allHere(roster).slice(0, 9),
      { playerId: 'p10', status: 'leaveEarly', availableUntilSec: 1200 },
    ]
    const plan = generatePlan(input(roster, { attendance }))
    for (const s of plan.shifts) {
      if (s.startSec >= 1200) expect(onField(s)).not.toContain('p10')
    }
  })

  it('plays everyone the whole game when short-handed', () => {
    const roster = squad(6) // six players at a 7v7 game
    const plan = generatePlan(input(roster))
    for (const p of roster) expect(plan.assigned.get(p.id)).toBe(END)
    expect(plan.warnings.length).toBeGreaterThan(0)
  })
})

describe('generatePlan — keepers', () => {
  it('never puts an unwilling player in goal', () => {
    const roster = [
      ...squad(8, { gk: 'never' }),
      player('k1', { gk: 'preferred' }),
      player('k2', { gk: 'willing' }),
    ]
    const plan = generatePlan(input(roster))
    for (const s of plan.shifts) {
      expect(['k1', 'k2']).toContain(s.assignments['gk'])
    }
  })

  it('keeps the same player in goal for a whole period', () => {
    const roster = squad(10)
    const plan = generatePlan(input(roster))
    const byPeriod = new Map<number, Set<string>>()
    for (const s of plan.shifts) {
      const set = byPeriod.get(s.period) ?? new Set<string>()
      const gk = s.assignments['gk']
      if (gk) set.add(gk)
      byPeriod.set(s.period, set)
    }
    for (const [period, set] of byPeriod) {
      expect(set.size, `period ${period}`).toBe(1)
    }
  })

  it('respects the per-game cap on periods in goal', () => {
    const roster = squad(10)
    const plan = generatePlan(input(roster))
    const periodsFor = new Map<string, Set<number>>()
    for (const s of plan.shifts) {
      const gk = s.assignments['gk']
      if (!gk) continue
      const set = periodsFor.get(gk) ?? new Set<number>()
      set.add(s.period)
      periodsFor.set(gk, set)
    }
    for (const [id, periods] of periodsFor) {
      expect(periods.size, id).toBeLessThanOrEqual(RULES.maxGkPeriodsPerPlayer)
    }
  })

  it('passes over whoever has kept goal most this season', () => {
    // Four periods and eight players on zero, so no single player is guaranteed
    // a turn. What is guaranteed is that the two who have done it six times
    // already are not asked again while anyone else is free.
    const roster = squad(10)
    const seasonGkPeriods = new Map([
      ['p1', 6],
      ['p2', 6],
    ])
    const plan = generatePlan(input(roster, { seasonGkPeriods }))
    const keepers = new Set(plan.shifts.map((s) => s.assignments['gk']))
    expect(keepers.has('p1')).toBe(false)
    expect(keepers.has('p2')).toBe(false)
    for (const k of keepers) expect(seasonGkPeriods.get(k as string) ?? 0).toBe(0)
  })

  it('shares goalkeeping when only two players are willing', () => {
    const roster = [
      ...squad(8, { gk: 'never' }),
      player('k1', { gk: 'willing' }),
      player('k2', { gk: 'willing' }),
    ]
    const plan = generatePlan(input(roster))
    const keepers = new Set(plan.shifts.map((s) => s.assignments['gk']))
    // Four periods, a cap of two each — both have to take a turn.
    expect(keepers).toEqual(new Set(['k1', 'k2']))
  })

  it('fills the goal anyway when nobody is willing, and warns', () => {
    const roster = squad(10, { gk: 'never' })
    const plan = generatePlan(input(roster))
    for (const s of plan.shifts) expect(s.assignments['gk']).toBeTruthy()
    expect(plan.warnings.join(' ')).toMatch(/willing keeper/i)
  })
})

describe('generatePlan — constraints', () => {
  it('honours pinned cells through a re-roll', () => {
    const roster = squad(10)
    const pins = [
      { shiftIndex: 0, slotId: 'st', playerId: 'p7' },
      { shiftIndex: 5, slotId: 'lb', playerId: 'p3' },
    ]
    for (const seed of [1, 2, 3, 4, 5]) {
      const plan = generatePlan(input(roster, { pins, seed }))
      expect(plan.shifts[0]!.assignments['st']).toBe('p7')
      expect(plan.shifts[5]!.assignments['lb']).toBe('p3')
    }
  })

  it('never puts a keep-apart pair on the field together', () => {
    const roster = squad(12)
    const pairings = [
      { id: 'x', teamId: 't', aId: 'p1', bId: 'p2', kind: 'keepApart' as const },
    ]
    const plan = generatePlan(input(roster, { pairings }))
    for (const s of plan.shifts) {
      const ids = onField(s)
      expect(ids.includes('p1') && ids.includes('p2')).toBe(false)
    }
  })

  it('mostly keeps players out of positions they avoid', () => {
    const roster = [
      player('avoider', { avoidGroups: ['DEF'] }),
      ...squad(11).slice(1),
    ]
    const plan = generatePlan(input(roster))
    const defSlots = new Set(
      FORMATION.slots.filter((s) => s.group === 'DEF').map((s) => s.id),
    )
    const inDefence = plan.shifts.filter((s) =>
      [...defSlots].some((id) => s.assignments[id] === 'avoider'),
    ).length
    expect(inDefence).toBe(0)
  })

  it('still uses an avoided position rather than leaving a slot empty', () => {
    // Everyone avoids defence — the planner must not give up on the back line.
    const roster = squad(10, { avoidGroups: ['DEF'] })
    const plan = generatePlan(input(roster))
    for (const s of plan.shifts) {
      expect(s.assignments['lb']).toBeTruthy()
      expect(s.assignments['rb']).toBeTruthy()
    }
  })
})

describe('replanFrom', () => {
  it('holds the players who are on the pitch right now', () => {
    const roster = squad(10)
    const base = generatePlan(input(roster))
    const idx = 2
    const current = base.shifts[idx]!.assignments

    const result = replanFrom(
      input(roster),
      idx,
      new Map(),
      { ...current },
      base.shifts,
    )
    expect(result.shifts[idx]!.assignments).toEqual(current)
  })

  it('leaves the shifts already played untouched', () => {
    const roster = squad(10)
    const base = generatePlan(input(roster))
    const idx = 6
    const result = replanFrom(input(roster), idx, new Map(), {}, base.shifts)
    for (let i = 0; i < idx; i++) {
      expect(result.shifts[i]!.assignments).toEqual(base.shifts[i]!.assignments)
    }
  })

  // Two dedicated keepers so the goal is out of the way: a keeper is locked into
  // their block and would otherwise dominate any count of shifts played.
  function outfieldSquad(): Player[] {
    return [
      ...squad(8, { gk: 'never' }),
      player('k1', { gk: 'preferred' }),
      player('k2', { gk: 'preferred' }),
    ]
  }

  it('rebalances the remainder against minutes actually played', () => {
    const roster = outfieldSquad()
    const base = generatePlan(input(roster))
    // p1 was left on for the whole first half by accident.
    const actual = new Map<string, number>([['p1', 1200]])
    const idx = 6 // start of the second half
    const result = replanFrom(input(roster), idx, actual, {}, base.shifts)

    const remaining = result.shifts.slice(idx)
    const p1Shifts = remaining.filter((s) => onField(s).includes('p1')).length
    const p2Shifts = remaining.filter((s) => onField(s).includes('p2')).length
    expect(p1Shifts).toBeLessThan(p2Shifts)
  })

  it('does not change the keeper halfway through a quarter', () => {
    // Re-planning from the middle of Q1 must leave Q1's keeper alone — swapping
    // them at the 3-minute mark is unfair to the child in goal and baffling to
    // everyone watching.
    const roster = squad(10)
    const base = generatePlan(input(roster))
    const startingKeeper = base.shifts[0]!.assignments['gk']

    const result = replanFrom(input(roster), 1, new Map(), {}, base.shifts)
    const q1 = result.shifts.filter((s) => s.period === 1)
    for (const s of q1) expect(s.assignments['gk']).toBe(startingKeeper)
  })

  it('does not count the first half twice', () => {
    // The bug this guards: replayed shifts adding their planned minutes on top
    // of the real minutes already supplied, so everyone looks over-played and
    // the second half is planned against nonsense.
    const roster = outfieldSquad()
    const base = generatePlan(input(roster))
    const idx = 6
    const played = new Map<string, number>()
    for (const p of roster) played.set(p.id, 840) // everyone even at halftime

    const result = replanFrom(input(roster), idx, played, {}, base.shifts)
    const second = result.shifts.slice(idx)
    const counts = roster
      .filter((p) => p.gk === 'never') // the keeper is locked to their block
      .map((p) => second.filter((s) => onField(s).includes(p.id)).length)
    // Even credit in means an even split of what is left.
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
  })
})

describe('keeper rotation frequency', () => {
  it('gives one keeper a whole half when the minimum is 20 minutes', () => {
    const roster = squad(10)
    const plan = generatePlan(
      input(roster, { rules: { ...RULES, gkMinMinutes: 20 } }),
    )
    const keeperByPeriod = new Map<number, string>()
    for (const s of plan.shifts) {
      const gk = s.assignments['gk']
      if (gk) keeperByPeriod.set(s.period, gk)
    }
    // Four ten-minute quarters, twenty-minute minimum: two keepers, not four.
    expect(new Set(keeperByPeriod.values()).size).toBe(2)
    expect(keeperByPeriod.get(1)).toBe(keeperByPeriod.get(2))
    expect(keeperByPeriod.get(3)).toBe(keeperByPeriod.get(4))
    expect(keeperByPeriod.get(1)).not.toBe(keeperByPeriod.get(3))
  })

  it('falls back to one keeper per period when the minimum is short', () => {
    const roster = squad(10)
    const plan = generatePlan(
      input(roster, { rules: { ...RULES, gkMinMinutes: 5, maxGkPeriodsPerPlayer: 1 } }),
    )
    const keeperByPeriod = new Map<number, string>()
    for (const s of plan.shifts) {
      const gk = s.assignments['gk']
      if (gk) keeperByPeriod.set(s.period, gk)
    }
    expect(new Set(keeperByPeriod.values()).size).toBe(4)
  })

  it('never changes keeper inside a period, whatever the minimum', () => {
    for (const gkMinMinutes of [5, 10, 20, 40]) {
      const plan = generatePlan(
        input(squad(10), { rules: { ...RULES, gkMinMinutes, maxGkPeriodsPerPlayer: 4 } }),
      )
      const byPeriod = new Map<number, Set<string>>()
      for (const s of plan.shifts) {
        const set = byPeriod.get(s.period) ?? new Set<string>()
        const gk = s.assignments['gk']
        if (gk) set.add(gk)
        byPeriod.set(s.period, set)
      }
      for (const [period, set] of byPeriod) {
        expect(set.size, `gkMinMinutes ${gkMinMinutes}, period ${period}`).toBe(1)
      }
    }
  })

  it('keeps one keeper all game when the minimum covers it', () => {
    const plan = generatePlan(
      input(squad(10), {
        rules: { ...RULES, gkMinMinutes: 40, maxGkPeriodsPerPlayer: 4 },
      }),
    )
    const keepers = new Set(plan.shifts.map((s) => s.assignments['gk']))
    expect(keepers.size).toBe(1)
  })
})

describe('substitution rhythm', () => {
  // Two dedicated keepers so the goal is out of the way: a keeper legitimately
  // sits more, because twenty minutes in goal is already most of a fair share.
  function outfieldSquad(): Player[] {
    return [
      ...squad(8, { gk: 'never' }),
      player('k1', { gk: 'preferred' }),
      player('k2', { gk: 'preferred' }),
    ]
  }

  const FIVE: GameRules = { ...RULES, shiftMinutes: 5 }

  function benchAt(plan: PlannedShift[], roster: Player[], i: number): Set<string> {
    const on = new Set(onField(plan[i]!))
    return new Set(roster.filter((p) => !on.has(p.id)).map((p) => p.id))
  }

  it('brings the whole bench on at the first change', () => {
    // Three substitutes and a five-minute interval means all three go on
    // together. Dribbling two on and making the third wait is the thing that
    // gets a coach asked "why can't I go in yet?".
    const roster = outfieldSquad()
    const plan = generatePlan(input(roster, { rules: FIVE }))
    const first = benchAt(plan.shifts, roster, 0)
    const second = benchAt(plan.shifts, roster, 1)
    expect(first.size).toBe(3)
    for (const id of first) {
      expect(second.has(id), `${id} was left on the bench a second shift`).toBe(false)
    }
  })

  it('never leaves an outfielder on the bench two shifts running', () => {
    const roster = outfieldSquad()
    const plan = generatePlan(input(roster, { rules: FIVE }))
    const keepers = new Set(plan.shifts.map((sh) => sh.assignments['gk']))
    for (let i = 1; i < plan.shifts.length; i++) {
      const prev = benchAt(plan.shifts, roster, i - 1)
      const cur = benchAt(plan.shifts, roster, i)
      for (const id of prev) {
        if (keepers.has(id)) continue
        expect(cur.has(id), `${id} sat out shifts ${i - 1} and ${i}`).toBe(false)
      }
    }
  })

  it('does not overplay a keeper for the goal time they are owed', () => {
    // Twenty minutes in goal is most of a fair share, so a keeper gets less
    // outfield time. Before this was accounted for they finished seven minutes
    // over, and repair clawed it back out of the earliest shifts.
    const roster = outfieldSquad()
    const plan = generatePlan(input(roster, { rules: FIVE }))
    for (const p of roster) {
      const dev = (plan.assigned.get(p.id) ?? 0) - (plan.target.get(p.id) ?? 0)
      expect(Math.abs(dev), `${p.id} is ${Math.round(dev / 60)} min off target`)
        .toBeLessThanOrEqual(300)
    }
  })
})
