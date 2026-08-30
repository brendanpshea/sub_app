import { db } from './db'
import type { GameEvent, GameEventBody } from '@/domain/types'
import { newId } from '@/domain/ids'

/**
 * The event log is append-only. Undo appends a VOID rather than deleting,
 * so the record of what actually happened on the day stays intact and every
 * derived number recomputes from the same source.
 */
export async function append(
  gameId: string,
  body: GameEventBody,
  tSec = 0,
): Promise<void> {
  await appendMany(gameId, [body], tSec)
}

export async function appendMany(
  gameId: string,
  bodies: GameEventBody[],
  tSec = 0,
): Promise<void> {
  if (bodies.length === 0) return
  await db.transaction('rw', db.events, async () => {
    const existing = await db.events.where('gameId').equals(gameId).toArray()
    let seq = existing.reduce((m, e) => Math.max(m, e.seq), 0)
    const wallAt = Date.now()
    const rows: GameEvent[] = bodies.map((body) => ({
      id: newId('ev'),
      gameId,
      seq: ++seq,
      wallAt,
      t: tSec,
      body,
    }))
    await db.events.bulkAdd(rows)
  })
}

/** Void the most recent event that is not itself a void and not already voided. */
export async function undoLast(gameId: string): Promise<boolean> {
  return db.transaction('rw', db.events, async () => {
    const all = (await db.events.where('gameId').equals(gameId).toArray()).sort(
      (a, b) => a.seq - b.seq,
    )
    const voided = new Set<number>()
    for (const e of all) if (e.body.type === 'VOID') voided.add(e.body.seq)

    for (let i = all.length - 1; i >= 0; i--) {
      const e = all[i]!
      if (e.body.type === 'VOID' || voided.has(e.seq)) continue
      const seq = all.reduce((m, x) => Math.max(m, x.seq), 0) + 1
      await db.events.add({
        id: newId('ev'),
        gameId,
        seq,
        wallAt: Date.now(),
        t: e.t,
        body: { type: 'VOID', seq: e.seq },
      })
      return true
    }
    return false
  })
}

/**
 * Void a whole substitution rather than one half of it. Undoing a sub one
 * event at a time would leave the field in a state that never existed.
 */
export async function undoLastGroup(gameId: string): Promise<boolean> {
  return db.transaction('rw', db.events, async () => {
    const all = (await db.events.where('gameId').equals(gameId).toArray()).sort(
      (a, b) => a.seq - b.seq,
    )
    const voided = new Set<number>()
    for (const e of all) if (e.body.type === 'VOID') voided.add(e.body.seq)

    const alive = all.filter((e) => e.body.type !== 'VOID' && !voided.has(e.seq))
    const last = alive[alive.length - 1]
    if (!last) return false

    // Events written together share a wall-clock timestamp.
    const group = alive.filter((e) => e.wallAt === last.wallAt)
    let seq = all.reduce((m, x) => Math.max(m, x.seq), 0)
    await db.events.bulkAdd(
      group.map((e) => ({
        id: newId('ev'),
        gameId,
        seq: ++seq,
        wallAt: Date.now(),
        t: e.t,
        body: { type: 'VOID' as const, seq: e.seq },
      })),
    )
    return true
  })
}

export function eventsOf(gameId: string): Promise<GameEvent[]> {
  return db.events.where('gameId').equals(gameId).toArray()
}

export async function clearEvents(gameId: string): Promise<void> {
  await db.events.where('gameId').equals(gameId).delete()
}
