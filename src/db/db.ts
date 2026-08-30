import Dexie, { type Table } from 'dexie'
import type {
  Formation,
  Game,
  GameEvent,
  Pairing,
  Plan,
  Player,
  Team,
} from '@/domain/types'
import { DEFAULT_RULES, nameSortKey } from '@/domain/types'
import { DEFAULT_FORMATION_ID } from '@/domain/formations'
import { newId } from '@/domain/ids'

class TouchlineDB extends Dexie {
  teams!: Table<Team, string>
  players!: Table<Player, string>
  pairings!: Table<Pairing, string>
  formations!: Table<Formation, string>
  games!: Table<Game, string>
  plans!: Table<Plan, string>
  events!: Table<GameEvent, string>

  constructor() {
    super('touchline')
    this.version(1).stores({
      teams: 'id, createdAt, name',
      players: 'id, teamId, [teamId+active], name',
      pairings: 'id, teamId',
      formations: 'id, teamId',
      games: 'id, teamId, kickoffAt, status, [teamId+status]',
      plans: 'gameId',
      events: 'id, gameId, [gameId+seq]',
    })

    // v2: names split into first and last, so two Harrisons can be told apart.
    this.version(2)
      .stores({
        players: 'id, teamId, [teamId+active], firstName',
      })
      .upgrade(async (tx) => {
        await tx
          .table('players')
          .toCollection()
          .modify((p: Record<string, unknown>) => {
            if (typeof p.firstName === 'string') return
            const parts = String(p.name ?? '')
              .trim()
              .split(/\s+/)
              .filter(Boolean)
            p.firstName = parts[0] ?? 'Player'
            if (parts.length > 1) p.lastName = parts.slice(1).join(' ')
            delete p.name
          })
      })
  }
}

export const db = new TouchlineDB()

// ---------------------------------------------------------------- teams

export async function createTeam(name: string, season: string): Promise<Team> {
  const team: Team = {
    id: newId('tm'),
    name: name.trim(),
    sport: 'soccer',
    season: season.trim(),
    defaultFormationId: DEFAULT_FORMATION_ID,
    rules: { ...DEFAULT_RULES },
    createdAt: Date.now(),
  }
  await db.teams.add(team)
  return team
}

export async function deleteTeam(teamId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.teams, db.players, db.pairings, db.formations, db.games, db.plans, db.events],
    async () => {
      const games = await db.games.where('teamId').equals(teamId).toArray()
      const gameIds = games.map((g) => g.id)
      for (const gid of gameIds) {
        await db.events.where('gameId').equals(gid).delete()
        await db.plans.where('gameId').equals(gid).delete()
      }
      await db.games.where('teamId').equals(teamId).delete()
      await db.players.where('teamId').equals(teamId).delete()
      await db.pairings.where('teamId').equals(teamId).delete()
      await db.formations.where('teamId').equals(teamId).delete()
      await db.teams.delete(teamId)
    },
  )
}

// ---------------------------------------------------------------- players

export async function addPlayer(
  teamId: string,
  firstName: string,
  lastName?: string,
  patch: Partial<Player> = {},
): Promise<Player> {
  const last = lastName?.trim()
  const player: Player = {
    id: newId('pl'),
    teamId,
    firstName: firstName.trim(),
    ...(last ? { lastName: last } : {}),
    active: true,
    gk: 'willing',
    preferredGroups: [],
    avoidGroups: [],
    createdAt: Date.now(),
    ...patch,
  }
  await db.players.add(player)
  return player
}

export async function updatePlayer(id: string, patch: Partial<Player>): Promise<void> {
  await db.players.update(id, patch)
}

export async function deletePlayer(id: string): Promise<void> {
  await db.transaction('rw', [db.players, db.pairings], async () => {
    await db.players.delete(id)
    const pairs = await db.pairings.toArray()
    const doomed = pairs.filter((p) => p.aId === id || p.bId === id).map((p) => p.id)
    if (doomed.length) await db.pairings.bulkDelete(doomed)
  })
}

export async function rosterOf(teamId: string): Promise<Player[]> {
  const all = await db.players.where('teamId').equals(teamId).toArray()
  return all.sort((a, b) => nameSortKey(a).localeCompare(nameSortKey(b)))
}

/** What deleting a team would take with it. Shown before it happens. */
export async function teamFootprint(
  teamId: string,
): Promise<{ players: number; games: number; events: number }> {
  const games = await db.games.where('teamId').equals(teamId).toArray()
  let events = 0
  for (const g of games) {
    events += await db.events.where('gameId').equals(g.id).count()
  }
  return {
    players: await db.players.where('teamId').equals(teamId).count(),
    games: games.length,
    events,
  }
}

// ---------------------------------------------------------------- pairings

export async function addPairing(
  teamId: string,
  aId: string,
  bId: string,
  kind: Pairing['kind'],
): Promise<void> {
  const existing = await db.pairings.where('teamId').equals(teamId).toArray()
  const dup = existing.find(
    (p) =>
      (p.aId === aId && p.bId === bId) || (p.aId === bId && p.bId === aId),
  )
  if (dup) {
    await db.pairings.update(dup.id, { kind })
    return
  }
  await db.pairings.add({ id: newId('pr'), teamId, aId, bId, kind })
}

export async function deletePairing(id: string): Promise<void> {
  await db.pairings.delete(id)
}

// ---------------------------------------------------------------- formations

export async function saveCustomFormation(f: Formation): Promise<void> {
  await db.formations.put(f)
}
