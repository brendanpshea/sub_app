import { describe, expect, it } from 'vitest'
import { buildShiftGrid, fairShareSec } from './fairness'
import { DEFAULT_RULES, gameLengthSec, type Attendance, type GameRules } from './types'

const RULES: GameRules = { ...DEFAULT_RULES } // 7v7, 4 × 10 min, 3 min shifts
const GAME = gameLengthSec(RULES) // 2400s
const HALF = GAME / 2

function present(...ids: string[]): Attendance[] {
  return ids.map((playerId) => ({ playerId, status: 'available' as const }))
}

function names(n: number, prefix = 'p'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`)
}

describe('fairShareSec', () => {
  it('splits the game evenly when everyone plays the whole game', () => {
    const share = fairShareSec(RULES, present(...names(10)))
    for (const id of names(10)) {
      // 7 × 2400 / 10 = 1680s = 28 minutes
      expect(share.get(id)).toBeCloseTo(1680, 6)
    }
  })

  it('allocates every available minute and no more', () => {
    const share = fairShareSec(RULES, present(...names(10)))
    const total = [...share.values()].reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(RULES.playersOnField * GAME, 6)
  })

  it('gives a late arrival an even share of what remains', () => {
    // Nine at kickoff, one arriving at halftime — the worked example in the spec.
    const attendance: Attendance[] = [
      ...present(...names(9)),
      { playerId: 'late', status: 'late', availableFromSec: HALF },
    ]
    const share = fairShareSec(RULES, attendance)

    // First half: pool of 9  → 1200 × 7/9  = 933.3s
    // Second half: pool of 10 → 1200 × 7/10 = 840s
    expect(share.get('p1')).toBeCloseTo(933.333 + 840, 2) // ≈ 1773.3s ≈ 29.6 min
    expect(share.get('late')).toBeCloseTo(840, 6) //          =  840.0s  = 14.0 min

    // And the books still balance.
    const total = [...share.values()].reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(RULES.playersOnField * GAME, 4)
  })

  it('treats leaving early as the mirror of arriving late', () => {
    const attendance: Attendance[] = [
      ...present(...names(9)),
      { playerId: 'early', status: 'leaveEarly', availableUntilSec: HALF },
    ]
    const share = fairShareSec(RULES, attendance)
    expect(share.get('early')).toBeCloseTo(840, 6)
    expect(share.get('p1')).toBeCloseTo(933.333 + 840, 2)
  })

  it('excludes absent players entirely', () => {
    const attendance: Attendance[] = [
      ...present(...names(9)),
      { playerId: 'away', status: 'absent' },
    ]
    const share = fairShareSec(RULES, attendance)
    expect(share.has('away')).toBe(false)
    // Nine players now split the whole game: 7 × 2400 / 9
    expect(share.get('p1')).toBeCloseTo((7 * GAME) / 9, 6)
  })

  it('does not invent owed minutes when short-handed', () => {
    // Six players at a 7v7 game: everyone plays the whole game, nobody is owed.
    const share = fairShareSec(RULES, present(...names(6)))
    for (const id of names(6)) expect(share.get(id)).toBeCloseTo(GAME, 6)
  })

  it('handles a player who arrives late and leaves early', () => {
    const attendance: Attendance[] = [
      ...present(...names(9)),
      {
        playerId: 'brief',
        status: 'late',
        availableFromSec: 600,
        availableUntilSec: 1200,
      },
    ]
    const share = fairShareSec(RULES, attendance)
    // Present for one 600s window against a pool of 10.
    expect(share.get('brief')).toBeCloseTo((600 * 7) / 10, 6)
    const total = [...share.values()].reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(RULES.playersOnField * GAME, 4)
  })
})

describe('buildShiftGrid', () => {
  it('never lets a shift span a period boundary', () => {
    const periodSec = RULES.periodMinutes * 60
    for (const s of buildShiftGrid(RULES)) {
      expect(Math.floor(s.startSec / periodSec) + 1).toBe(s.period)
      expect(s.endSec).toBeLessThanOrEqual(s.period * periodSec)
    }
  })

  it('divides each period evenly rather than leaving a stub', () => {
    // 10-minute quarters at a 3-minute target → three shifts of 3:20, not 3/3/3/1.
    const grid = buildShiftGrid(RULES)
    expect(grid.length).toBe(12)
    const q1 = grid.filter((s) => s.period === 1)
    expect(q1.length).toBe(3)
    for (const s of q1) expect(s.endSec - s.startSec).toBeCloseTo(200, 0)
  })

  it('covers the whole game with no gaps', () => {
    const grid = buildShiftGrid(RULES)
    expect(grid[0]!.startSec).toBe(0)
    expect(grid[grid.length - 1]!.endSec).toBe(GAME)
    for (let i = 1; i < grid.length; i++) {
      expect(grid[i]!.startSec).toBe(grid[i - 1]!.endSec)
    }
  })

  it('always produces at least one shift per period', () => {
    const long = buildShiftGrid({ ...RULES, shiftMinutes: 60 })
    expect(long.length).toBe(RULES.periodCount)
  })
})
