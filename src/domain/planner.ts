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
 * Four passes:
 *   1. Keepers, at period granularity — the tightest constraint, and children
 *      need a whole quarter to settle into the position.
 *   2. Field slots, deficit-greedy, tightest slots first.
 *   3. Repair — a bounded local search that closes the remaining spread.
 *   4. Smoothing — breaks up runs of consecutive shifts on the bench without
 *      letting anyone's total drift, because level minutes still read as unfair
 *      when the waiting arrives in one lump.
 */

export const WEIGHTS = {
  /** Primary driver: minutes owed, in minutes. */
  deficit: 1.0,
  /** Staying put. This is what produces rolling subs with no special mechanism. */
  continuity: 0.35,
  /**
   * A position the player likes. Deliberately small: mid-game it should break
   * a tie and nothing more, because insisting on it costs someone else their
   * share of the game for no reason a child would notice.
   */
  preferred: 0.15,
  /**
   * The same preference at the first shift of a period. This is where a coach
   * cares — the starting eleven and the shape coming out of half time are the
   * ones people see and remember — so here it outweighs a moderate deficit.
   */
  preferredOpening: 2.5,
  /**
   * Per shift already spent waiting. Deliberately larger than `continuity`:
   * when two players are owed the same time, the one sitting on the bench goes
   * on. Multiplied by the length of the wait, so a second consecutive shift on
   * the bench is close to unbeatable — nobody should have to ask why they
   * cannot go in yet.
   */
  rested: 0.9,
  keepTogether: 0.2,
  variety: 0.15,
} as const

const REPAIR_ITERATIONS = 200

export interface PlannerInput {
  rules: GameRules
  formation: Formation
  roster: Player[]
  attendance: Attendance[]
  pairings?: Pairing[]
  pins?: Pin[]
  seed?: number
  /**
   * Outfield seconds already played this game, excluding time in goal.
   * Set when re-planning mid-game. Goal time is accounted for separately,
   * because it is committed a whole block at a time.
   */
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
  /**
   * Largest gap between any player's total time and an equal share of the
   * game. Goal duty makes this non-zero by design: a keeper is on the pitch
   * for their whole stint while the outfielders around them rotate.
   */
  spreadSec: number
  /**
   * The same measure over outfield time only — what the planner actually
   * equalises, and the number to judge a chart by.
   */
  outfieldSpreadSec: number
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
  // When the goal is ordinary it is filled by the same pass as everything else,
  // competing on the same deficit, and its minutes count the same.
  const goalOrdinary = goalIsOrdinaryPosition(rules)
  const fieldSlots = goalOrdinary
    ? [...formation.slots]
    : formation.slots.filter((s) => s.requiredRole !== 'GK')

  // Running state
  const credit = new Map<ID, number>(input.startingCredit ?? [])
  const target = new Map<ID, number>()
  const outTarget = new Map<ID, number>()
  const consecutive = new Map<ID, number>()
  const benchStreak = new Map<ID, number>()
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
  if (gkSlotDef && !goalOrdinary) {
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

    /**
     * Outfield time is shared out among whoever is not in goal at the time.
     *
     * Goal duty is its own rotation and is deliberately kept out of this
     * ledger. Counting it here would make the fairness of a child's game
     * depend on *when* they kept goal — keep first and you are then held back
     * for the rest of the match, keep last and you finish well over. And
     * pre-emptively sitting a player because they are down to keep goal later
     * spends their minutes on a prediction: plans change, half-time changes
     * them most, and the child who sat gets nothing back. So the planner only
     * ever reacts to goal time that has actually been served.
     */
    if (goalOrdinary) {
      // Nothing is held out, so the shared ledger is simply the fair share.
      for (const [id, sec] of inc) outTarget.set(id, (outTarget.get(id) ?? 0) + sec)
    } else {
      const shiftKeeper = gkSlotDef ? shift.assignments[gkSlotDef.id] : undefined
      const outfielders = [...(increments[i]?.keys() ?? [])].filter(
        (id) => id !== shiftKeeper,
      )
      if (outfielders.length > 0) {
        const each =
          (duration * Math.min(fieldSlots.length, outfielders.length)) /
          outfielders.length
        for (const id of outfielders) {
          outTarget.set(id, (outTarget.get(id) ?? 0) + each)
        }
      }
    }

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
        benchStreak,
        groupSec,
        roster,
        goalOrdinary,
        input.startingCredit === undefined,
      )
      continue
    }

    const eligible = eligibleDuring(windows, slice)
    // Preferred positions carry real weight at the start of a period — the
    // starting eleven and the shape out of half time are what people see.
    const isPeriodOpening = i === 0 || grid[i - 1]?.period !== slice.period
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
      const wantsKeeper = slot.requiredRole === 'GK'
      const available = roster.filter(
        (p) =>
          eligible.has(p.id) &&
          !taken.has(p.id) &&
          p.id !== keeper &&
          // Nobody is put in goal who has said they will not go in it.
          (!wantsKeeper || p.gk !== 'never') &&
          !breaksKeepApart(p.id, taken, pairings),
      )

      // "Avoids defence" is a tier, not a weight. A coach who sees their stated
      // constraint quietly outvoted by a two-minute deficit stops trusting the
      // planner — and that mistrust costs more than the imbalance saved. So the
      // avoiders are only considered when nobody else can take the slot, which
      // is exactly "relaxes when the pool empties".
      const willing = available.filter((p) => !p.avoidGroups.includes(slot.group))
      const pool = willing.length > 0 ? willing : available

      // The cap on shifts in a row is a tier for the same reason. A coach who
      // says "three blocks then a rest" means it, and a soft penalty loses that
      // argument to any deficit worth a couple of minutes. It relaxes only when
      // there is nobody left who is under the cap.
      const fresh = pool.filter(
        (p) =>
          (consecutive.get(p.id) ?? 0) <
          (p.maxConsecutiveShifts ?? rules.maxConsecutiveShifts),
      )
      const candidates = fresh.length > 0 ? fresh : pool

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
          target: outTarget,
          carry,
          consecutive,
          benchStreak,
          isPeriodOpening,
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
      benchStreak,
      groupSec,
      roster,
      goalOrdinary,
      true,
    )
  }

  // ---- pass 3: repair --------------------------------------------------

  const balanceArgs: RepairArgs = {
    shifts,
    grid,
    formation,
    roster,
    windows,
    pins,
    pairings,
    from,
    byId,
    target: outTarget,
    outfieldOnly: !goalOrdinary,
    ...(input.startingCredit ? { startingCredit: input.startingCredit } : {}),
  }
  repair(balanceArgs)
  smoothBenchRuns(balanceArgs)

  const assigned = totalAssigned(shifts, grid, formation)
  const outAssigned = totalAssigned(shifts, grid, formation, 0, undefined, !goalOrdinary)
  return {
    shifts,
    seed,
    warnings: dedupe(warnings),
    assigned,
    target,
    spreadSec: spreadOf(assigned, target, roster),
    outfieldSpreadSec: spreadOf(outAssigned, outTarget, roster),
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
      if (who) {
        a.keeperOf.set(block.key, who)
        // Already played, but it still counts against their turns in goal —
        // otherwise a re-plan can hand the same child a second stint.
        a.gkPeriodsThisGame.set(
          who,
          (a.gkPeriodsThisGame.get(who) ?? 0) + block.periods.length,
        )
      }
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
    // A block can span several periods, and the per-game cap counts periods.
    a.gkPeriodsThisGame.set(
      chosen,
      (a.gkPeriodsThisGame.get(chosen) ?? 0) + block.periods.length,
    )
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
  periods: number[]
}

/**
 * How long one keeper stays in goal.
 *
 * Always a whole number of periods, and never fewer than one: swapping keepers
 * mid-quarter means doing it at a throw-in, which is fiddly and leaves a goal
 * briefly unguarded. `gkMinMinutes` then widens the block further — 20 minutes
 * of ten-minute quarters gives two keepers a half each rather than four
 * keepers a quarter each.
 */
export function shiftLengthSec(rules: GameRules): number {
  const grid = buildShiftGrid(rules)
  const first = grid[0]
  return first ? first.endSec - first.startSec : rules.periodMinutes * 60
}

/**
 * Whether the goal is just another position.
 *
 * A keeper held in goal for a whole period is a different kind of thing from a
 * shift: it dominates their game, so it gets its own rotation and its own
 * ledger. Set the shortest stint to a single shift and that stops being true —
 * the goal rotates with everything else, its minutes count like everything
 * else, and a keeper change is an ordinary substitution.
 */
export function goalIsOrdinaryPosition(rules: GameRules): boolean {
  const want = (rules.gkMinMinutes ?? rules.periodMinutes) * 60
  return want <= shiftLengthSec(rules) + 1
}

export function keeperBlockPeriods(rules: GameRules): number {
  const want = rules.gkMinMinutes ?? rules.periodMinutes
  const n = Math.ceil(want / Math.max(1, rules.periodMinutes))
  return Math.max(1, Math.min(rules.periodCount, n))
}

function keeperBlocks(rules: GameRules, grid: ShiftSlice[]): KeeperBlock[] {
  const per = keeperBlockPeriods(rules)
  const byKey = new Map<number, KeeperBlock>()

  for (const s of grid) {
    const key = Math.floor((s.period - 1) / per)
    const b = byKey.get(key)
    if (b) {
      b.endSec = Math.max(b.endSec, s.endSec)
      b.shiftIndices.push(s.index)
      if (!b.periods.includes(s.period)) b.periods.push(s.period)
    } else {
      byKey.set(key, {
        key,
        startSec: s.startSec,
        endSec: s.endSec,
        shiftIndices: [s.index],
        periods: [s.period],
      })
    }
  }
  return [...byKey.values()].sort((a, b) => a.key - b.key)
}

// ---------------------------------------------------------------- scoring

interface ScoreArgs {
  player: Player
  slot: Slot
  credit: Map<ID, number>
  target: Map<ID, number>
  carry: Map<ID, number>
  consecutive: Map<ID, number>
  benchStreak: Map<ID, number>
  isPeriodOpening: boolean
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
  if (a.player.preferredGroups.includes(a.slot.group)) {
    s += a.isPeriodOpening ? WEIGHTS.preferredOpening : WEIGHTS.preferred
  }

  // Scaled by how many shifts they have already waited, so a long wait wins.
  const waited = a.benchStreak.get(id) ?? 0
  if (waited > 0) s += WEIGHTS.rested * waited

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
  /** False when the goal is an ordinary position and counts like the rest. */
  outfieldOnly: boolean
  startingCredit?: Map<ID, number>
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

  /**
   * Hand one shift from `over` to `under`, if any shift legally allows it and
   * doing so actually helps.
   *
   * Moving a block of length `d` only reduces the imbalance when the gap
   * between the two players is wider than the block itself; otherwise the two
   * simply trade places in the table and the next pass swaps them back. Without
   * that test repair churns for its whole iteration budget, shredding the tidy
   * rotation the greedy pass produced and stranding a substitute on the bench
   * for two shifts running.
   */
  const trySwap = (over: Player, under: Player, gap: number): boolean => {
    // Latest shift first. The greedy pass leaves a tidy rotation, and the shifts
    // a coach cares about are the ones about to happen — several may already
    // have been announced to the children. Balancing the far end of the game
    // costs nobody anything; unpicking the next two substitutions does.
    for (let i = a.shifts.length - 1; i >= a.from; i--) {
      const shift = a.shifts[i]!
      const slice = a.grid[i]!
      if (gap <= slice.endSec - slice.startSec) continue
      const eligible = eligibleDuring(a.windows, slice)
      if (!eligible.has(under.id)) continue

      const entries = Object.entries(shift.assignments)
      if (entries.some(([, pid]) => pid === under.id)) continue

      const found = entries.find(([slotId, pid]) => {
        if (pid !== over.id) return false
        // A keeper held for a whole block is not repair's to move; an ordinary
        // one is, provided whoever takes the gloves is willing.
        if (a.outfieldOnly && slotId === gkSlotId) return false
        if (!mayPlay(under, slotId)) return false
        return !a.pins.some((p) => p.shiftIndex === i && p.slotId === slotId)
      })
      if (!found) continue

      const others = new Set(
        entries.filter(([sid]) => sid !== found[0]).map(([, pid]) => pid),
      )
      if (breaksKeepApart(under.id, others, a.pairings)) continue

      shift.assignments[found[0]] = under.id
      return true
    }
    return false
  }

  for (let iter = 0; iter < REPAIR_ITERATIONS; iter++) {
    // Mirror the scoring pass: when real minutes were supplied for the shifts
    // already played, use those rather than the minutes those shifts were
    // planned to produce, or the first half gets counted twice over.
    // Repair can only move outfield slots, so it must judge itself on the
    // outfield ledger. Measuring against totals would have it chasing an
    // imbalance created by goal time it is not allowed to touch.
    const assigned = totalAssigned(
      a.shifts,
      a.grid,
      a.formation,
      a.startingCredit ? a.from : 0,
      a.startingCredit,
      a.outfieldOnly,
    )
    const devs = a.roster
      .map((p) => ({ p, dev: (assigned.get(p.id) ?? 0) - (a.target.get(p.id) ?? 0) }))
      .sort((x, y) => y.dev - x.dev)

    // Work down from the most over-played and up from the most under-played
    // rather than giving up on the first pair that cannot be swapped. A keeper
    // is often the most over-played player and cannot be moved out of goal, and
    // stopping there used to abandon imbalances elsewhere that were fixable.
    const shortest = Math.min(
      ...a.grid.slice(a.from).map((sl) => sl.endSec - sl.startSec),
    )

    let swapped = false
    for (const over of devs) {
      if (swapped) break
      for (let j = devs.length - 1; j >= 0; j--) {
        const under = devs[j]!
        if (under.p.id === over.p.id) break
        const gap = over.dev - under.dev
        if (gap <= shortest) break
        if (trySwap(over.p, under.p, gap)) {
          swapped = true
          break
        }
      }
    }
    if (!swapped) return
  }
}

/**
 * Break up runs of consecutive shifts on the bench.
 *
 * Balancing minutes says nothing about how the waiting is distributed, so a
 * player can finish level on time yet sit out the last two shifts in a row —
 * which is precisely what gets a coach asked "why can't I go in yet?", and
 * worst of all at the end of a game when there is no later shift to make up
 * for it.
 *
 * Every swap here keeps both players inside the spread the plan has already
 * achieved, so the rotation gets tidier without anyone's total getting worse.
 */
function smoothBenchRuns(a: RepairArgs): void {
  const gkSlotId = a.formation.slots.find((sl) => sl.requiredRole === 'GK')?.id
  const slotById = new Map(a.formation.slots.map((sl) => [sl.id, sl]))

  const universallyAvoided = new Set<PositionGroup>()
  for (const slot of a.formation.slots) {
    if (a.roster.every((p) => p.avoidGroups.includes(slot.group))) {
      universallyAvoided.add(slot.group)
    }
  }
  const mayPlay = (p: Player, slotId: SlotId): boolean => {
    const slot = slotById.get(slotId)
    if (!slot) return false
    if (slot.requiredRole === 'GK' && p.gk === 'never') return false
    if (!p.avoidGroups.includes(slot.group)) return true
    return universallyAvoided.has(slot.group)
  }

  const onAt = (i: number): Set<ID> =>
    new Set(Object.values(a.shifts[i]?.assignments ?? {}))

  for (let pass = 0; pass < 40; pass++) {
    const assigned = totalAssigned(
      a.shifts,
      a.grid,
      a.formation,
      a.startingCredit ? a.from : 0,
      a.startingCredit,
      a.outfieldOnly,
    )
    const devOf = (id: ID): number =>
      (assigned.get(id) ?? 0) - (a.target.get(id) ?? 0)
    let worst = 0
    for (const p of a.roster) worst = Math.max(worst, Math.abs(devOf(p.id)))

    // One swap per pass. Deviations are recomputed from scratch each time, so
    // acting on more than one before refreshing them would let a second swap
    // reason from numbers the first has already invalidated.
    let changed = false
    scan: for (let i = Math.max(a.from, 1); i < a.shifts.length; i++) {
      const slice = a.grid[i]
      const shift = a.shifts[i]
      if (!slice || !shift) continue
      const d = slice.endSec - slice.startSec
      // Never wider than the spread the plan already achieved. Allowing even a
      // shift's slack here lets each pass licence the next, and the imbalance
      // ratchets away from the floor the balancing pass worked to reach.
      const bound = worst

      const prevOn = onAt(i - 1)
      const nowOn = onAt(i)
      const nextOn = i + 1 < a.shifts.length ? onAt(i + 1) : null
      const eligible = eligibleDuring(a.windows, slice)

      const stranded = a.roster.filter(
        (p) => !prevOn.has(p.id) && !nowOn.has(p.id) && eligible.has(p.id),
      )

      for (const x of stranded) {
        if (Math.abs(devOf(x.id) + d) > bound) continue

        const entry = Object.entries(shift.assignments).find(([slotId, pid]) => {
          if (a.outfieldOnly && slotId === gkSlotId) return false
          if (!prevOn.has(pid)) return false // would only move the wait around
          if (nextOn && !nextOn.has(pid)) return false // would strand them instead
          if (a.pins.some((pin) => pin.shiftIndex === i && pin.slotId === slotId)) {
            return false
          }
          if (!mayPlay(x, slotId)) return false
          const y = a.byId.get(pid)
          if (!y || Math.abs(devOf(pid) - d) > bound) return false
          const others = new Set(
            Object.entries(shift.assignments)
              .filter(([sid]) => sid !== slotId)
              .map(([, other]) => other),
          )
          return !breaksKeepApart(x.id, others, a.pairings)
        })
        if (!entry) continue

        shift.assignments[entry[0]] = x.id
        changed = true
        break scan
      }
    }

    if (!changed) return
  }
}

// ---------------------------------------------------------------- helpers

function applyShiftAccounting(
  shift: PlannedShift,
  formation: Formation,
  duration: number,
  credit: Map<ID, number>,
  consecutive: Map<ID, number>,
  benchStreak: Map<ID, number>,
  groupSec: Map<ID, Record<PositionGroup, number>>,
  roster: Player[],
  creditGoal: boolean,
  countCredit: boolean,
): void {
  const onField = new Set<ID>()
  for (const slot of formation.slots) {
    const pid = shift.assignments[slot.id]
    if (!pid) continue
    onField.add(pid)
    // Goal time only joins the shared ledger when the goal is an ordinary
    // position. When it is a separate duty the target side already leaves the
    // keeper out of the outfield share, so crediting them for it here too
    // would count the stint twice and starve them of play afterwards.
    if (countCredit && (creditGoal || slot.requiredRole !== 'GK')) {
      credit.set(pid, (credit.get(pid) ?? 0) + duration)
    }
    const rec = groupSec.get(pid)
    if (rec) rec[slot.group] += duration
  }
  for (const p of roster) {
    const on = onField.has(p.id)
    consecutive.set(p.id, on ? (consecutive.get(p.id) ?? 0) + 1 : 0)
    benchStreak.set(p.id, on ? 0 : (benchStreak.get(p.id) ?? 0) + 1)
  }
}

function totalAssigned(
  shifts: PlannedShift[],
  grid: ShiftSlice[],
  formation: Formation,
  from = 0,
  base?: Map<ID, number>,
  outfieldOnly = false,
): Map<ID, number> {
  const out = new Map<ID, number>(base ?? [])
  for (let i = from; i < shifts.length; i++) {
    const shift = shifts[i]!
    const slice = grid[i]
    if (!slice) continue
    const duration = slice.endSec - slice.startSec
    for (const slot of formation.slots) {
      if (outfieldOnly && slot.requiredRole === 'GK') continue
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
