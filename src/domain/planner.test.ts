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
    name: id,
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
    const atSec = 500 // inside shift index 2
    const idx = GRID.findIndex((s) => s.endSec > atSec)
    const current = base.shifts[idx]!.assignments

    const result = replanFrom(input(roster), atSec, new Map(), { ...current })
    expect(result.shifts[idx]!.assignments).toEqual(current)
  })

  it('rebalances the remainder against minutes actually played', () => {
    const roster = squad(10)
    // p1 has been left on for the whole first half by accident.
    const actual = new Map<string, number>([['p1', 1200]])
    const atSec = 1200
    const idx = GRID.findIndex((s) => s.endSec > atSec)
    const result = replanFrom(input(roster), atSec, actual, {})

    // The remaining shifts should now favour everyone except p1.
    const remaining = result.shifts.slice(idx)
    const p1Shifts = remaining.filter((s) => onField(s).includes('p1')).length
    const p2Shifts = remaining.filter((s) => onField(s).includes('p2')).length
    expect(p1Shifts).toBeLessThan(p2Shifts)
  })
})
