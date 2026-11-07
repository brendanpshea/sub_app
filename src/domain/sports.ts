import type { GameRules, PositionGroup, SportId } from './types'
import { DEFAULT_RULES } from './types'

/**
 * Everything that differs between sports, in one place.
 *
 * The planner, the clock and the event log know nothing about which game is
 * being played: they share out minutes across positions. What changes is the
 * vocabulary, the shapes on offer, whether one position needs a keeper, and
 * what gets written on the scoresheet.
 *
 * Position groups are reused rather than multiplied. Basketball's guards,
 * forwards and center sit in the same three groups as soccer's defence,
 * midfield and attack — furthest from the basket to nearest — so preferences,
 * avoids and the season's variety bonus work unchanged.
 */

export interface FormatPreset {
  label: string
  periodCount: number
  periodMinutes: number
}

export interface SportProfile {
  id: SportId
  label: string
  /** What the playing surface is called: pitch, court. */
  surface: string
  /** The button that starts the game. */
  start: string
  /** Field groups in the order a coach lists them. */
  groups: PositionGroup[]
  /** Short label for a group, for chips. */
  groupShort: Record<PositionGroup, string>
  /** "2 guards, 2 forwards, 1 center" — `n` is the count. */
  groupPhrase: (group: PositionGroup, n: number) => string
  hasKeeper: boolean
  /** Goals count one each; baskets carry their own value. */
  scoring: 'goals' | 'points'
  /** Personal fouls before a player has to leave the game, if the sport has one. */
  foulLimit?: number
  presets: FormatPreset[]
  playersOnField: { min: number; max: number }
  defaultRules: GameRules
  defaultFormationId: string
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`

export const SPORTS: Record<SportId, SportProfile> = {
  soccer: {
    id: 'soccer',
    label: 'Soccer',
    surface: 'pitch',
    start: 'KICK OFF',
    groups: ['DEF', 'MID', 'FWD'],
    groupShort: { GK: 'Keeper', DEF: 'Def', MID: 'Mid', FWD: 'Fwd' },
    groupPhrase: (g, n) =>
      `${n} ${{ GK: 'keeper', DEF: 'at the back', MID: 'in midfield', FWD: 'up top' }[g]}`,
    hasKeeper: true,
    scoring: 'goals',
    presets: [
      { label: '4 × 10', periodCount: 4, periodMinutes: 10 },
      { label: '4 × 12', periodCount: 4, periodMinutes: 12 },
      { label: '2 × 20', periodCount: 2, periodMinutes: 20 },
      { label: '2 × 25', periodCount: 2, periodMinutes: 25 },
      { label: '2 × 30', periodCount: 2, periodMinutes: 30 },
      { label: '4 × 15', periodCount: 4, periodMinutes: 15 },
    ],
    playersOnField: { min: 3, max: 11 },
    defaultRules: DEFAULT_RULES,
    defaultFormationId: 'f7_231',
  },
  basketball: {
    id: 'basketball',
    label: 'Basketball',
    surface: 'court',
    start: 'TIP OFF',
    groups: ['DEF', 'MID', 'FWD'],
    groupShort: { GK: '—', DEF: 'Guard', MID: 'Forward', FWD: 'Center' },
    groupPhrase: (g, n) =>
      g === 'DEF'
        ? plural(n, 'guard', 'guards')
        : g === 'MID'
          ? plural(n, 'forward', 'forwards')
          : g === 'FWD'
            ? plural(n, 'center', 'centers')
            : '',
    hasKeeper: false,
    scoring: 'points',
    foulLimit: 5,
    presets: [
      { label: '4 × 6', periodCount: 4, periodMinutes: 6 },
      { label: '4 × 8', periodCount: 4, periodMinutes: 8 },
      { label: '4 × 10', periodCount: 4, periodMinutes: 10 },
      { label: '2 × 16', periodCount: 2, periodMinutes: 16 },
      { label: '2 × 20', periodCount: 2, periodMinutes: 20 },
    ],
    playersOnField: { min: 3, max: 5 },
    defaultRules: {
      ...DEFAULT_RULES,
      periodCount: 4,
      periodMinutes: 8,
      playersOnField: 5,
      shiftMinutes: 4,
      // No keeper, so nothing to rotate; kept short so the goal, were there
      // one, would count as an ordinary position.
      gkMinMinutes: 4,
      maxConsecutiveShifts: 3,
    },
    defaultFormationId: 'b5_std',
  },
}

export function sportOf(id: SportId | undefined): SportProfile {
  return SPORTS[id ?? 'soccer'] ?? SPORTS.soccer
}

