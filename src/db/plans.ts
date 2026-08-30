import { db } from './db'
import type { Pin, Plan, PlannedShift } from '@/domain/types'

export function loadPlan(gameId: string): Promise<Plan | undefined> {
  return db.plans.get(gameId)
}

export async function savePlan(
  gameId: string,
  shifts: PlannedShift[],
  seed: number,
  pins: Pin[],
): Promise<void> {
  await db.plans.put({ gameId, generatedAt: Date.now(), seed, shifts, pins })
}

export async function clearPlan(gameId: string): Promise<void> {
  await db.plans.delete(gameId)
}

/** Pins are a set keyed by cell; pinning the same cell twice replaces it. */
export function togglePin(pins: Pin[], pin: Pin): Pin[] {
  const existing = pins.find(
    (p) => p.shiftIndex === pin.shiftIndex && p.slotId === pin.slotId,
  )
  if (existing && existing.playerId === pin.playerId) {
    return pins.filter((p) => p !== existing)
  }
  return [...pins.filter((p) => p !== existing), pin]
}

export function isPinned(pins: Pin[], shiftIndex: number, slotId: string): boolean {
  return pins.some((p) => p.shiftIndex === shiftIndex && p.slotId === slotId)
}
