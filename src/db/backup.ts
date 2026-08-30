import { db } from './db'
import type {
  Formation,
  Game,
  GameEvent,
  Pairing,
  Plan,
  Player,
  Team,
} from '@/domain/types'

/**
 * Local-only storage means a lost phone is a lost season, so export and import
 * ship in v1 as both backup and device transfer — not as a later nicety.
 */

const FORMAT = 'touchline-backup'
const FORMAT_VERSION = 1

export interface Backup {
  format: typeof FORMAT
  version: number
  exportedAt: number
  teams: Team[]
  players: Player[]
  pairings: Pairing[]
  formations: Formation[]
  games: Game[]
  plans: Plan[]
  events: GameEvent[]
}

export async function buildBackup(): Promise<Backup> {
  const [teams, players, pairings, formations, games, plans, events] = await Promise.all([
    db.teams.toArray(),
    db.players.toArray(),
    db.pairings.toArray(),
    db.formations.toArray(),
    db.games.toArray(),
    db.plans.toArray(),
    db.events.toArray(),
  ])
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    exportedAt: Date.now(),
    teams,
    players,
    pairings,
    formations,
    games,
    plans,
    events,
  }
}

export async function downloadBackup(): Promise<void> {
  const data = await buildBackup()
  const stamp = new Date().toISOString().slice(0, 10)
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `touchline-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export interface ImportResult {
  teams: number
  players: number
  games: number
  events: number
}

function isBackup(x: unknown): x is Backup {
  if (!x || typeof x !== 'object') return false
  const b = x as Partial<Backup>
  return b.format === FORMAT && Array.isArray(b.teams) && Array.isArray(b.players)
}

/**
 * Merge, never clobber: records are written by id, so importing a backup onto
 * a device that already has some of the season adds what is missing and
 * refreshes what is stale, rather than wiping the local copy.
 */
export async function importBackup(json: string): Promise<ImportResult> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('That file is not valid JSON.')
  }
  if (!isBackup(parsed)) {
    throw new Error('That does not look like a Touchline backup.')
  }
  if (parsed.version > FORMAT_VERSION) {
    throw new Error(
      `That backup was made by a newer version of Touchline (v${parsed.version}). Update the app first.`,
    )
  }

  await db.transaction(
    'rw',
    [db.teams, db.players, db.pairings, db.formations, db.games, db.plans, db.events],
    async () => {
      await db.teams.bulkPut(parsed.teams ?? [])
      await db.players.bulkPut(parsed.players ?? [])
      await db.pairings.bulkPut(parsed.pairings ?? [])
      await db.formations.bulkPut(parsed.formations ?? [])
      await db.games.bulkPut(parsed.games ?? [])
      await db.plans.bulkPut(parsed.plans ?? [])
      await db.events.bulkPut(parsed.events ?? [])
    },
  )

  return {
    teams: parsed.teams?.length ?? 0,
    players: parsed.players?.length ?? 0,
    games: parsed.games?.length ?? 0,
    events: parsed.events?.length ?? 0,
  }
}
