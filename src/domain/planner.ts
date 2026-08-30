import type {
  Attendance,
  Formation,
  GameRules,
  ID,
  Pairing,
  Pin,
  PlannedShift,
  Player,
  PositionGroup,
  Slot,
  SlotId,
} from './types'
import { emptyGroupRecord } from './types'
import {
  availabilityWindows,
  buildShiftGrid,
  eligibleDuring,
  fairShareByShift,
  type AvailabilityWindow,
  type ShiftSlice,
} from './fairness'
import { mulberry32 } from './ids'

/**
 * The planner.
 *
 * Deliberately greedy plus a cheap repair pass rather than a constraint solver.
 * It runs in milliseconds, which is what makes the re-roll button feel instant,
 * and coaches accept the charts it produces. The scoring weights below are the
 * whole of the "intelligence" and are meant to be tuned against real rosters.
 *
 * Three passes:
 *   1. Keepers, at period granularity — the tightest constraint, and children
 *      need a whole quarter to settle into the position.
 *   2. Field slots, deficit-greedy, tightest slots first.
 *   3. Repair — a bounded local search that closes the remaining spread.
 */

export const WEIGHTS = {
  /** Primary driver: minutes owed, in minutes. */
  deficit: 1.0,
  /** Staying put. This is what produces rolling subs with no special mechanism. */
  continuity: 0.35,
  preferred: 0.3,
  rested: 0.25,
  keepTogether: 0.2,
  variety: 0.15,
  overConsecutive: -0.5,
} as const

const REPAIR_ITERATIONS = 200
const REPAIR_TOLERANCE_SEC = 20

export interface PlannerInput {
  rules: GameRules
  formation: Formation
  roster: Player[]
  attendance: Attendance[]
  pairings?: Pairing[]
  pins?: Pin[]
  seed?: number
  /** Seconds already played this game. Set when re-planning mid-game. */
  startingCredit?: Map<ID, number>
  /** Season debt in seconds, positive means owed. Scaled by rules.seasonCarryWeight. */
  carriedDeficit?: Map<ID, number>
  /** Season seconds per position group, for the variety bonus. */
  seasonByGroup?: Map<ID, Record<PositionGroup, number>>
  /** Season goalkeeping periods, for keeper rotation across the season. */
  seasonGkPeriods?: Map<ID, number>
  /** Re-plan only from this shift onwards, keeping earlier shifts as they are. */
  fromShiftIndex?: number
  existing?: PlannedShift[]
}

export interface PlanResult {
  shifts: PlannedShift[]
  seed: number
  warnings: string[]
  /** Seconds assigned per player across the whole plan. */
  assigned: Map<ID, number>
  /** Fair share in seconds per player. */
  target: Map<ID, number>
  /** Largest gap between any player's assigned time and their target. */
  spreadSec: number
}

// ---------------------------------------------------------------- entry point

export function generatePlan(input: PlannerInput): PlanResult {
  const { rules, formation, roster } = input
  const seed = input.seed ?? Math.floor(Math.random() * 2 ** 31)
  const rand = mulberry32(seed)
  const warnings: string[] = []

  const grid = buildShiftGrid(rules)
  const windows = availabilityWindows(rules, input.attendance)
  const increments = fairShareByShift(rules, input.attendance, grid)

  const byId = new Map(roster.map((p) => [p.id, p]))
  const pins = input.pins ?? []
  const pairings = input.pairings ?? []
  const from = input.fromShiftIndex ?? 0

  const gkSlotDef = formation.slots.find((s) => s.requiredRole === 'GK')
  const fieldSlots = formation.slots.filter((s) => s.requiredRole !== 'GK')

  // Running state
  const credit = new Map<ID, number>(input.startingCredit ?? [])
  const target = new Map<ID, number>()
  const consecutive = new Map<ID, number>()
  const gkPeriodsThisGame = new Map<ID, number>()
  const groupSec = new Map<ID, Record<PositionGroup, number>>()

  for (const p of roster) {
    if (!credit.has(p.id)) credit.set(p.id, 0)
    groupSec.set(p.id, emptyGroupRecord())
  }

  // Season debt nudges rather than dominates.
  const carry = new Map<ID, number>()
  for (const [id, sec] of input.carriedDeficit ?? []) {
    carry.set(id, sec * clamp01(rules.seasonCarryWeight))
  }

  const shifts: PlannedShift[] = grid.map((s, i) => {
    const kept = input.existing?.[i]
    return {
      index: s.index,
      period: s.period,
      startSec: s.startSec,
      endSec: s.endSec,
      assignments: i < from && kept ? { ...kept.assignments } : {},
    }
  })

  // ---- pass 1: keepers -------------------------------------------------

  const keeperOf = new Map<number, ID>() // block key -> playerId
  if (gkSlotDef) {
    assignKeepers({
      rules,
      grid,
      shifts,
      gkSlotDef,
      roster,
      windows,
      pins,
      from,
      rand,
      seasonGkPeriods: input.seasonGkPeriods,
      gkPeriodsThisGame,
      keeperOf,
      warnings,
    })
  }

  // ---- pass 2: field slots --------------------------------------------

  for (let i = 0; i < grid.length; i++) {
    const slice = grid[i]!
    const shift = shifts[i]!
    const duration = slice.endSec - slice.startSec
    const inc = increments[i] ?? new Map<ID, number>()
    for (const [id, sec] of inc) target.set(id, (target.get(id) ?? 0) + sec)

    if (i < from) {
      // Replayed shift: not re-decided. Its minutes are only added when no
      // real credit was supplied — during a mid-game re-plan `startingCredit`
      // already holds what was actually played, and adding the planned
      // minutes on top would count the first half of the game twice.
      applyShiftAccounting(
        shift,
        formation,
        duration,
        credit,
        consecutive,
        groupSec,
        roster,
        input.startingCredit === undefined,
      )
      continue
    }

    const eligible = eligibleDuring(windows, slice)
    const previous = i > 0 ? shifts[i - 1] : undefined
    const keeper = gkSlotDef ? shift.assignments[gkSlotDef.id] : undefined

    // Tightest slots first: the ones with the smallest pool of willing players.
    const ordered = [...fieldSlots].sort(
      (a, b) => poolSize(a, roster, eligible) - poolSize(b, roster, eligible),
    )

    for (const slot of ordered) {
      const pin = pins.find((p) => p.shiftIndex === i && p.slotId === slot.id)
      if (pin && eligible.has(pin.playerId)) {
        shift.assignments[slot.id] = pin.playerId
        continue
      }

      const taken = new Set(Object.values(shift.assignments))
      const available = roster.filter(
        (p) =>
          eligible.has(p.id) &&
          !taken.has(p.id) &&
          p.id !== keeper &&
          !breaksKeepApart(p.id, taken, pairings),
      )

      // "Avoids defence" is a tier, not a weight. A coach who sees their stated
      // constraint quietly outvoted by a two-minute deficit stops trusting the
      // planner — and that mistrust costs more than the imbalance saved. So the
      // avoiders are only considered when nobody else can take the slot, which
      // is exactly "relaxes when the pool empties".
      const willing = available.filter((p) => !p.avoidGroups.includes(slot.group))
      const candidates = willing.length > 0 ? willing : available

      if (candidates.length === 0) {
        warnings.push(`Nobody available for ${slot.label} in shift ${i + 1}.`)
        continue
      }

      let best = candidates[0]!
      let bestScore = -Infinity
      for (const p of candidates) {
        const s = score({
          player: p,
          slot,
          credit,
          target,
          carry,
          consecutive,
          previous,
          groupSec,
          seasonByGroup: input.seasonByGroup,
          pairings,
          taken,
          rules,
          rand,
        })
        if (s > bestScore) {
          bestScore = s
          best = p
        }
      }
      shift.assignments[slot.id] = best.id
    }

    applyShiftAccounting(
      shift,
      formation,
      duration,
      credit,
      consecutive,
      groupSec,
      roster,
      true,
    )
  }

  // ---- pass 3: repair --------------------------------------------------

  repair({ shifts, grid, formation, roster, windows, pins, pairings, from, byId, target })

  const assigned = totalAssigned(shifts, grid, formation)
  return {
    shifts,
    seed,
    warnings: dedupe(warnings),
    assigned,
    target,
    spreadSec: spreadOf(assigned, target, roster),
  }
}

// ---------------------------------------------------------------- pass 1

interface KeeperArgs {
  rules: GameRules
  grid: ShiftSlice[]
  shifts: PlannedShift[]
  gkSlotDef: Slot
  roster: Player[]
  windows: AvailabilityWindow[]
  pins: Pin[]
  from: number
  rand: () => number
  seasonGkPeriods?: Map<ID, number>
  gkPeriodsThisGame: Map<ID, number>
  keeperOf: Map<number, ID>
  warnings: string[]
}

function assignKeepers(a: KeeperArgs): void {
  const blocks = keeperBlocks(a.rules, a.grid)

  for (const block of blocks) {
    const indices = block.shiftIndices
    if (indices.every((i) => i < a.from)) {
      const kept = indices[0] !== undefined ? a.shifts[indices[0]] : undefined
      const who = kept?.assignments[a.gkSlotDef.id]
      if (who) a.keeperOf.set(block.key, who)
      continue
    }

    // A pin anywhere in the block fixes the keeper for the whole block, because
    // a keeper is chosen for a quarter, not for a three-minute shift.
    const pinned = a.pins.find(
      (p) => p.slotId === a.gkSlotDef.id && indices.includes(p.shiftIndex),
    )

    // If part of this block has already been played or fixed, the keeper for it
    // is settled. A re-plan that swapped keepers halfway through a quarter would
    // be both unfair to the child in goal and baffling to everyone watching.
    const carried = indices
      .filter((i) => i < a.from)
      .map((i) => a.shifts[i]?.assignments[a.gkSlotDef.id])
      .find((x): x is ID => !!x)

    let chosen: ID | undefined = pinned?.playerId ?? carried

    if (!chosen) {
      const willing = a.roster.filter(
        (p) =>
          p.gk !== 'never' &&
          availableThroughout(p.id, a.windows, block.startSec, block.endSec) &&
          (a.gkPeriodsThisGame.get(p.id) ?? 0) < a.rules.maxGkPeriodsPerPlayer,
      )

      let pool = willing
      if (pool.length === 0) {
        // Never leave the goal empty. Fall back, but say so.
        pool = a.roster.filter((p) =>
          availableThroughout(p.id, a.windows, block.startSec, block.endSec),
        )
        if (pool.length > 0) {
          a.warnings.push(
            'No willing keeper was available for every period — someone has been put in goal anyway.',
          )
        }
      }
      if (pool.length === 0) {
        a.warnings.push('Nobody is available to keep goal in one of the periods.')
        continue
      }

      // Season rotation first: whoever has kept goal least often this season.
      chosen = pool
        .map((p) => ({
          p,
          season: a.seasonGkPeriods?.get(p.id) ?? 0,
          game: a.gkPeriodsThisGame.get(p.id) ?? 0,
          pref: p.gk === 'preferred' ? 0 : 1,
          jitter: a.rand(),
        }))
        .sort(
          (x, y) =>
            x.season - y.season ||
            x.game - y.game ||
            x.pref - y.pref ||
            x.jitter - y.jitter,
        )[0]!.p.id
    }

    a.keeperOf.set(block.key, chosen)
    a.gkPeriodsThisGame.set(chosen, (a.gkPeriodsThisGame.get(chosen) ?? 0) + 1)
    for (const i of indices) {
      if (i < a.from) continue
      const shift = a.shifts[i]
      if (shift) shift.assignments[a.gkSlotDef.id] = chosen
    }
  }
}

interface KeeperBlock {
  key: number
  startSec: number
  endSec: number
  shiftIndices: number[]
}

function keeperBlocks(rules: GameRules, grid: ShiftSlice[]): KeeperBlock[] {
  if (rules.gkRotation === 'byShift') {
    return grid.map((s) => ({
      key: s.index,
      startSec: s.startSec,
      endSec: s.endSec,
      shiftIndices: [s.index],
    }))
  }
  const byPeriod = new Map<number, KeeperBlock>()
  for (const s of grid) {
    const b = byPeriod.get(s.period)
    if (b) {
      b.endSec = Math.max(b.endSec, s.endSec)
      b.shiftIndices.push(s.index)
    } else {
      byPeriod.set(s.period, {
        key: s.period,
        startSec: s.startSec,
        endSec: s.endSec,
        shiftIndices: [s.index],
      })
    }
  }
  return [...byPeriod.values()].sort((a, b) => a.key - b.key)
}

// ---------------------------------------------------------------- scoring

interface ScoreArgs {
  player: Player
  slot: Slot
  credit: Map<ID, number>
  target: Map<ID, number>
  carry: Map<ID, number>
  consecutive: Map<ID, number>
  previous: PlannedShift | undefined
  groupSec: Map<ID, Record<PositionGroup, number>>
  seasonByGroup?: Map<ID, Record<PositionGroup, number>>
  pairings: Pairing[]
  taken: Set<ID>
  rules: GameRules
  rand: () => number
}

function score(a: ScoreArgs): number {
  const id = a.player.id
  const deficitSec =
    (a.target.get(id) ?? 0) - (a.credit.get(id) ?? 0) + (a.carry.get(id) ?? 0)

  let s = WEIGHTS.deficit * (deficitSec / 60)

  const wasHere = a.previous?.assignments[a.slot.id] === id
  if (wasHere) s += WEIGHTS.continuity

  // Avoided groups are filtered out before scoring — see the tier note above.
  if (a.player.preferredGroups.includes(a.slot.group)) s += WEIGHTS.preferred

  const playedLast =
    a.previous !== undefined && Object.values(a.previous.assignments).includes(id)
  if (!playedLast) s += WEIGHTS.rested

  const limit = a.player.maxConsecutiveShifts ?? a.rules.maxConsecutiveShifts
  if ((a.consecutive.get(id) ?? 0) >= limit) s += WEIGHTS.overConsecutive

  for (const pair of a.pairings) {
    if (pair.kind !== 'keepTogether') continue
    const other = pair.aId === id ? pair.bId : pair.bId === id ? pair.aId : undefined
    if (other && a.taken.has(other)) s += WEIGHTS.keepTogether
  }

  // Variety: nudge towards a group this player has seen least of this season.
  const season = a.seasonByGroup?.get(id)
  if (season) {
    const total = season.DEF + season.MID + season.FWD
    if (total > 0) {
      const shareHere = (season[a.slot.group] ?? 0) / total
      s += WEIGHTS.variety * (1 - shareHere)
    }
  }

  // The balance slider: 0 is strictly equal, 1 is loose.
  s += a.rand() * clamp01(a.rules.balance) * 1.5

  return s
}

// ---------------------------------------------------------------- pass 3

interface RepairArgs {
  shifts: PlannedShift[]
  grid: ShiftSlice[]
  formation: Formation
  roster: Player[]
  windows: AvailabilityWindow[]
  pins: Pin[]
  pairings: Pairing[]
  from: number
  byId: Map<ID, Player>
  target: Map<ID, number>
}

/**
 * Greedy assignment reliably leaves a few minutes of spread. A bounded local
 * search closes it: repeatedly take a shift off whoever is furthest over their
 * target and give it to whoever is furthest under, whenever that swap is legal.
 */
function repair(a: RepairArgs): void {
  const gkSlotId = a.formation.slots.find((s) => s.requiredRole === 'GK')?.id
  const slotById = new Map(a.formation.slots.map((s) => [s.id, s]))

  // Repair must respect the same avoid tier as pass two, or it would quietly
  // reintroduce the violations that pass two was careful to prevent.
  const universallyAvoided = new Set<PositionGroup>()
  for (const slot of a.formation.slots) {
    if (a.roster.every((p) => p.avoidGroups.includes(slot.group))) {
      universallyAvoided.add(slot.group)
    }
  }
  const mayPlay = (p: Player, slotId: SlotId): boolean => {
    const slot = slotById.get(slotId)
    if (!slot) return false
    if (!p.avoidGroups.includes(slot.group)) return true
    return universallyAvoided.has(slot.group)
  }

  for (let iter = 0; iter < REPAIR_ITERATIONS; iter++) {
    const assigned = totalAssigned(a.shifts, a.grid, a.formation)

    let over: Player | undefined
    let under: Player | undefined
    let overDev = -Infinity
    let underDev = Infinity
    for (const p of a.roster) {
      const dev = (assigned.get(p.id) ?? 0) - (a.target.get(p.id) ?? 0)
      if (dev > overDev) {
        overDev = dev
        over = p
      }
      if (dev < underDev) {
        underDev = dev
        under = p
      }
    }
    if (!over || !under || over.id === under.id) return
    if (overDev - underDev <= REPAIR_TOLERANCE_SEC) return

    let swapped = false
    for (let i = a.from; i < a.shifts.length; i++) {
      const shift = a.shifts[i]!
      const slice = a.grid[i]!
      const eligible = eligibleDuring(a.windows, slice)
      if (!eligible.has(under.id)) continue

      const entries = Object.entries(shift.assignments)
      if (entries.some(([, pid]) => pid === under.id)) continue

      const found = entries.find(([slotId, pid]) => {
        if (pid !== over!.id) return false
        if (slotId === gkSlotId) return false
        if (!mayPlay(under!, slotId)) return false
        return !a.pins.some((p) => p.shiftIndex === i && p.slotId === slotId)
      })
      if (!found) continue

      const others = new Set(
        entries.filter(([sid]) => sid !== found[0]).map(([, pid]) => pid),
      )
      if (breaksKeepApart(under.id, others, a.pairings)) continue

      shift.assignments[found[0]] = under.id
      swapped = true
      break
    }
    if (!swapped) return
  }
}

// ---------------------------------------------------------------- helpers

function applyShiftAccounting(
  shift: PlannedShift,
  formation: Formation,
  duration: number,
  credit: Map<ID, number>,
  consecutive: Map<ID, number>,
  groupSec: Map<ID, Record<PositionGroup, number>>,
  roster: Player[],
  countCredit: boolean,
): void {
  const onField = new Set<ID>()
  for (const slot of formation.slots) {
    const pid = shift.assignments[slot.id]
    if (!pid) continue
    onField.add(pid)
    if (countCredit) credit.set(pid, (credit.get(pid) ?? 0) + duration)
    const rec = groupSec.get(pid)
    if (rec) rec[slot.group] += duration
  }
  for (const p of roster) {
    consecutive.set(p.id, onField.has(p.id) ? (consecutive.get(p.id) ?? 0) + 1 : 0)
  }
}

function totalAssigned(
  shifts: PlannedShift[],
  grid: ShiftSlice[],
  formation: Formation,
): Map<ID, number> {
  const out = new Map<ID, number>()
  for (let i = 0; i < shifts.length; i++) {
    const shift = shifts[i]!
    const slice = grid[i]
    if (!slice) continue
    const duration = slice.endSec - slice.startSec
    for (const slot of formation.slots) {
      const pid = shift.assignments[slot.id]
      if (!pid) continue
      out.set(pid, (out.get(pid) ?? 0) + duration)
    }
  }
  return out
}

function spreadOf(
  assigned: Map<ID, number>,
  target: Map<ID, number>,
  roster: Player[],
): number {
  let lo = Infinity
  let hi = -Infinity
  for (const p of roster) {
    if (!target.has(p.id)) continue
    const dev = (assigned.get(p.id) ?? 0) - (target.get(p.id) ?? 0)
    lo = Math.min(lo, dev)
    hi = Math.max(hi, dev)
  }
  return hi === -Infinity ? 0 : hi - lo
}

function poolSize(slot: Slot, roster: Player[], eligible: Set<ID>): number {
  return roster.filter((p) => eligible.has(p.id) && !p.avoidGroups.includes(slot.group))
    .length
}

function breaksKeepApart(id: ID, taken: Set<ID>, pairings: Pairing[]): boolean {
  for (const pair of pairings) {
    if (pair.kind !== 'keepApart') continue
    if (pair.aId === id && taken.has(pair.bId)) return true
    if (pair.bId === id && taken.has(pair.aId)) return true
  }
  return false
}

function availableThroughout(
  id: ID,
  windows: AvailabilityWindow[],
  startSec: number,
  endSec: number,
): boolean {
  const w = windows.find((x) => x.playerId === id)
  return !!w && w.fromSec <= startSec && w.untilSec >= endSec
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)]
}

// ---------------------------------------------------------------- re-planning

/**
 * Re-planning is not a special code path. It is the planner called again with
 * real minutes as its starting state — which is only possible because credit
 * comes from the event log rather than from the plan it is replacing.
 */
export function replanFrom(
  input: PlannerInput,
  fromShiftIndex: number,
  actualCredit: Map<ID, number>,
  currentOnField: Record<SlotId, ID>,
  existing: PlannedShift[],
): PlanResult {
  // Hold the players who are on the pitch right now; only the future is negotiable.
  const holdPins: Pin[] = Object.entries(currentOnField).map(([slotId, playerId]) => ({
    shiftIndex: fromShiftIndex,
    slotId,
    playerId,
  }))

  return generatePlan({
    ...input,
    startingCredit: actualCredit,
    existing,
    pins: [
      ...(input.pins ?? []).filter((p) => p.shiftIndex > fromShiftIndex),
      ...holdPins,
    ],
    fromShiftIndex,
  })
}
