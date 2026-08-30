/**
 * Core domain types.
 *
 * Two rules govern everything in here:
 *  1. The Plan is a schedule of intentions and is disposable.
 *     The event log is append-only and is the only source of truth.
 *  2. Goalkeeper minutes count exactly like every other minute.
 *     There is no weighted ledger.
 */

export type ID = string
export type SlotId = string
export type SportId = 'soccer'

export type PositionGroup = 'GK' | 'DEF' | 'MID' | 'FWD'

export const POSITION_GROUPS: PositionGroup[] = ['GK', 'DEF', 'MID', 'FWD']

export const GROUP_LABEL: Record<PositionGroup, string> = {
  GK: 'Keeper',
  DEF: 'Defence',
  MID: 'Midfield',
  FWD: 'Attack',
}

// ---------------------------------------------------------------- rules

export interface GameRules {
  periodCount: number //          4
  periodMinutes: number //        10
  playersOnField: number //       7
  shiftMinutes: number //         3 — target sub cadence, not a hard rule
  subMode: 'stoppage' | 'window'
  maxPlayersPerSub: number //     2 — soft cap; deficit absorbs the remainder
  gkRotation: 'byPeriod' | 'byShift'
  maxGkPeriodsPerPlayer: number
  maxConsecutiveShifts: number
  seasonCarryWeight: number //    0..1 — how hard last week's debt pulls
  balance: number //              0 = strictly equal, 1 = loose
}

export const DEFAULT_RULES: GameRules = {
  periodCount: 4,
  periodMinutes: 10,
  playersOnField: 7,
  shiftMinutes: 3,
  subMode: 'stoppage',
  maxPlayersPerSub: 2,
  gkRotation: 'byPeriod',
  maxGkPeriodsPerPlayer: 2,
  maxConsecutiveShifts: 4,
  seasonCarryWeight: 0.5,
  balance: 0.15,
}

// ---------------------------------------------------------------- team & roster

export interface Team {
  id: ID
  name: string
  sport: SportId
  season: string
  defaultFormationId: ID
  rules: GameRules
  createdAt: number
}

/** How willing a player is to go in goal. */
export type GkWillingness = 'never' | 'willing' | 'preferred'

export interface Player {
  id: ID
  teamId: ID
  name: string //                 short display name — must read at arm's length
  number?: number
  active: boolean
  gk: GkWillingness
  preferredGroups: PositionGroup[]
  avoidGroups: PositionGroup[]
  maxConsecutiveShifts?: number // per-player fitness override
  notes?: string
  createdAt: number
}

export type PairingKind = 'keepApart' | 'keepTogether'

export interface Pairing {
  id: ID
  teamId: ID
  aId: ID
  bId: ID
  kind: PairingKind
}

// ---------------------------------------------------------------- formation

export interface Slot {
  id: SlotId //                   'lb'
  label: string //                'LB'
  group: PositionGroup
  x: number //                    0..1, left to right
  y: number //                    0..1, 1 = own goal
  requiredRole?: 'GK'
}

export interface Formation {
  id: ID
  sport: SportId
  name: string //                 '2-3-1'
  playersOnField: number
  slots: Slot[]
  builtIn: boolean
  teamId?: ID //                  set only for custom formations
}

// ---------------------------------------------------------------- game

export type AttendanceStatus =
  | 'available'
  | 'absent'
  | 'late'
  | 'leaveEarly'
  | 'limited'

export interface Attendance {
  playerId: ID
  status: AttendanceStatus
  /** Game clock seconds, cumulative across periods. Drives fairShare. */
  availableFromSec?: number
  availableUntilSec?: number
  note?: string
}

export type GameStatus = 'planned' | 'live' | 'final'

export interface Game {
  id: ID
  teamId: ID
  opponent: string
  kickoffAt: number
  homeAway: 'home' | 'away'
  formationId: ID
  rules: GameRules //             snapshot — league rules vary by opponent
  attendance: Attendance[]
  status: GameStatus
  createdAt: number
}

// ---------------------------------------------------------------- plan

export interface PlannedShift {
  index: number
  period: number
  startSec: number
  endSec: number
  assignments: Record<SlotId, ID> // slotId -> playerId
}

export interface Pin {
  shiftIndex: number
  slotId: SlotId
  playerId: ID
}

export interface Plan {
  gameId: ID
  generatedAt: number
  seed: number
  shifts: PlannedShift[]
  pins: Pin[]
}

// ---------------------------------------------------------------- event log

export type GameEventBody =
  | { type: 'PERIOD_START'; period: number }
  | { type: 'PERIOD_END'; period: number }
  | { type: 'CLOCK_PAUSE' }
  | { type: 'CLOCK_RESUME' }
  | { type: 'CLOCK_ADJUST'; deltaSec: number; reason?: string }
  | { type: 'ON'; playerId: ID; slotId: SlotId }
  | { type: 'OFF'; playerId: ID; slotId: SlotId }
  | { type: 'MOVE'; playerId: ID; fromSlotId: SlotId; toSlotId: SlotId }
  | { type: 'GOAL'; playerId?: ID; assistId?: ID } // ours only — the ref keeps the score
  | { type: 'SHOT'; playerId: ID }
  | { type: 'SAVE'; playerId: ID }
  | { type: 'NOTE'; text: string }
  | { type: 'VOID'; seq: number } // undo = append, never delete

export type GameEventType = GameEventBody['type']

export interface GameEvent {
  id: ID
  gameId: ID
  seq: number
  /** Date.now() — authoritative for clock derivation. */
  wallAt: number
  /** Game clock seconds. A cache; recomputed when CLOCK_ADJUST lands. */
  t: number
  body: GameEventBody
}

// ---------------------------------------------------------------- derived

export interface PlayerGameStats {
  playerId: ID
  fairShareSec: number
  totalSec: number
  fieldSec: number //             split for reporting only
  gkSec: number
  deficitSec: number //           fairShare - total; positive means owed
  secByGroup: Record<PositionGroup, number>
  gkPeriods: number
  stints: number
  goals: number
  assists: number
  shots: number
  saves: number
}

export interface PlayerSeasonStats {
  playerId: ID
  gamesAvailable: number
  gamesPlayed: number
  totalSec: number
  fieldSec: number
  gkSec: number
  secByGroup: Record<PositionGroup, number>
  gkPeriods: number
  /** Sum of (fairShare - total) over games attended. Seeds the next plan. */
  carriedDeficitSec: number
  goals: number
  assists: number
  shots: number
  saves: number
}

// ---------------------------------------------------------------- helpers

export function emptyGroupRecord(): Record<PositionGroup, number> {
  return { GK: 0, DEF: 0, MID: 0, FWD: 0 }
}

/** Total game length in seconds, from the rules snapshot. */
export function gameLengthSec(rules: GameRules): number {
  return rules.periodCount * rules.periodMinutes * 60
}

/** Which period (1-based) a cumulative game-clock second falls in. */
export function periodAt(rules: GameRules, sec: number): number {
  const per = rules.periodMinutes * 60
  return Math.min(rules.periodCount, Math.floor(sec / per) + 1)
}
