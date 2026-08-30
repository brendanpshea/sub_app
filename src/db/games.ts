import { db } from './db'
import type { Attendance, AttendanceStatus, Game, GameRules, Team } from '@/domain/types'
import { normaliseAttendance, reconcileAttendance } from '@/domain/attendance'
import { newId } from '@/domain/ids'

export { arrivalMarks, departureMarks, reconcileAttendance } from '@/domain/attendance'

/**
 * A game snapshots the team's rules and formation at creation time, because
 * league rules vary by opponent and changing a team default should never
 * silently rewrite games already played.
 */
export async function createGame(
  team: Team,
  opponent: string,
  kickoffAt: number,
  homeAway: Game['homeAway'],
): Promise<Game> {
  const roster = await db.players.where('teamId').equals(team.id).toArray()
  const game: Game = {
    id: newId('gm'),
    teamId: team.id,
    opponent: opponent.trim() || 'TBD',
    kickoffAt,
    homeAway,
    formationId: team.defaultFormationId,
    rules: { ...team.rules },
    attendance: roster
      .filter((p) => p.active)
      .map((p) => ({ playerId: p.id, status: 'available' as const })),
    status: 'planned',
    createdAt: Date.now(),
  }
  await db.games.add(game)
  return game
}

export async function updateGame(id: string, patch: Partial<Game>): Promise<void> {
  await db.games.update(id, patch)
}

export async function deleteGame(id: string): Promise<void> {
  await db.transaction('rw', [db.games, db.plans, db.events], async () => {
    await db.events.where('gameId').equals(id).delete()
    await db.plans.where('gameId').equals(id).delete()
    await db.games.delete(id)
  })
}

export async function updateRules(id: string, patch: Partial<GameRules>): Promise<void> {
  const game = await db.games.get(id)
  if (!game) return
  await db.games.update(id, { rules: { ...game.rules, ...patch } })
}

export async function setAttendance(
  gameId: string,
  playerId: string,
  patch: Partial<Attendance>,
): Promise<void> {
  const game = await db.games.get(gameId)
  if (!game) return
  const roster = await db.players.where('teamId').equals(game.teamId).toArray()
  const next = reconcileAttendance(game.attendance, roster).map((a) =>
    a.playerId === playerId ? normaliseAttendance({ ...a, ...patch }, game.rules) : a,
  )
  await db.games.update(gameId, { attendance: next })
}

export async function setAllAttendance(
  gameId: string,
  status: AttendanceStatus,
): Promise<void> {
  const game = await db.games.get(gameId)
  if (!game) return
  const roster = await db.players.where('teamId').equals(game.teamId).toArray()
  const next = reconcileAttendance(game.attendance, roster).map<Attendance>((a) => ({
    playerId: a.playerId,
    status,
  }))
  await db.games.update(gameId, { attendance: next })
}
