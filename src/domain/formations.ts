import type { Formation, Slot, PositionGroup } from './types'

/**
 * Built-in formation library.
 *
 * Coordinates are normalised: x runs 0 (left touchline) to 1 (right),
 * y runs 0 (opponent goal) to 1 (own goal). The same numbers drive both
 * the plan-time pitch preview and the live screen, so they only exist once.
 *
 * 7v7 is a keeper plus six outfield players; the name counts the outfield
 * players from the back, as coaches say them out loud.
 */

function slot(
  id: string,
  label: string,
  group: PositionGroup,
  x: number,
  y: number,
  requiredRole?: 'GK',
): Slot {
  return requiredRole ? { id, label, group, x, y, requiredRole } : { id, label, group, x, y }
}

const GK = slot('gk', 'GK', 'GK', 0.5, 0.93, 'GK')

function f(id: string, name: string, slots: Slot[]): Formation {
  return {
    id,
    sport: 'soccer',
    name,
    playersOnField: slots.length,
    slots,
    builtIn: true,
  }
}

export const BUILT_IN_FORMATIONS: Formation[] = [
  f('f7_231', '2-3-1', [
    GK,
    slot('lb', 'LB', 'DEF', 0.28, 0.72),
    slot('rb', 'RB', 'DEF', 0.72, 0.72),
    slot('lm', 'LM', 'MID', 0.17, 0.46),
    slot('cm', 'CM', 'MID', 0.5, 0.48),
    slot('rm', 'RM', 'MID', 0.83, 0.46),
    slot('st', 'ST', 'FWD', 0.5, 0.2),
  ]),
  f('f7_321', '3-2-1', [
    GK,
    slot('lb', 'LB', 'DEF', 0.2, 0.74),
    slot('cb', 'CB', 'DEF', 0.5, 0.77),
    slot('rb', 'RB', 'DEF', 0.8, 0.74),
    slot('lm', 'LM', 'MID', 0.32, 0.46),
    slot('rm', 'RM', 'MID', 0.68, 0.46),
    slot('st', 'ST', 'FWD', 0.5, 0.2),
  ]),
  f('f7_222', '2-2-2', [
    GK,
    slot('lb', 'LB', 'DEF', 0.28, 0.74),
    slot('rb', 'RB', 'DEF', 0.72, 0.74),
    slot('lm', 'LM', 'MID', 0.28, 0.5),
    slot('rm', 'RM', 'MID', 0.72, 0.5),
    slot('ls', 'LS', 'FWD', 0.34, 0.22),
    slot('rs', 'RS', 'FWD', 0.66, 0.22),
  ]),
  f('f7_312', '3-1-2', [
    GK,
    slot('lb', 'LB', 'DEF', 0.2, 0.74),
    slot('cb', 'CB', 'DEF', 0.5, 0.77),
    slot('rb', 'RB', 'DEF', 0.8, 0.74),
    slot('cm', 'CM', 'MID', 0.5, 0.5),
    slot('ls', 'LS', 'FWD', 0.34, 0.22),
    slot('rs', 'RS', 'FWD', 0.66, 0.22),
  ]),
  f('f7_132', '1-3-2', [
    GK,
    slot('cb', 'CB', 'DEF', 0.5, 0.77),
    slot('lm', 'LM', 'MID', 0.17, 0.5),
    slot('cm', 'CM', 'MID', 0.5, 0.52),
    slot('rm', 'RM', 'MID', 0.83, 0.5),
    slot('ls', 'LS', 'FWD', 0.34, 0.22),
    slot('rs', 'RS', 'FWD', 0.66, 0.22),
  ]),
]

export const DEFAULT_FORMATION_ID = 'f7_231'

export function findFormation(
  formations: Formation[] | undefined,
  id: string,
): Formation | undefined {
  return (
    BUILT_IN_FORMATIONS.find((x) => x.id === id) ?? formations?.find((x) => x.id === id)
  )
}

/** The single slot that must be filled by a keeper, if the formation has one. */
export function gkSlot(formation: Formation): Slot | undefined {
  return formation.slots.find((s) => s.requiredRole === 'GK')
}

export function outfieldSlots(formation: Formation): Slot[] {
  return formation.slots.filter((s) => s.requiredRole !== 'GK')
}

/** "2-3-1" from the slot list, for custom formations built by dragging. */
export function describeShape(slots: Slot[]): string {
  const counts: Record<string, number> = { DEF: 0, MID: 0, FWD: 0 }
  for (const s of slots) {
    if (s.requiredRole === 'GK') continue
    counts[s.group] = (counts[s.group] ?? 0) + 1
  }
  return [counts.DEF, counts.MID, counts.FWD].filter((n) => n && n > 0).join('-')
}
