import { useState, type ReactNode } from 'react'
import type { Formation, Player, SlotId } from '@/domain/types'
import { displayName, fullName } from '@/domain/types'
import Pitch, { type SlotFill } from './Pitch'
import Sheet from './Sheet'

interface Props {
  formation: Formation
  /** The lineup being edited: slot -> player. */
  assignments: Record<SlotId, string>
  /** Everyone who could take a position. */
  squad: Player[]
  label: string
  hint?: string
  /** Minutes played, shown on chips and in the picker where it helps. */
  minutesOf?: (playerId: string) => string
  onPick: (slotId: SlotId, playerId: string) => void
  onShuffle?: () => void
  footer?: ReactNode
}

/**
 * A pitch you can rearrange by tapping.
 *
 * The same component serves kick-off, every period break, and the "change
 * more" escape hatch mid-game — a coach only has to learn one gesture, and it
 * is the one place where moving a player who is staying on is a deliberate act
 * rather than something the planner did behind their back.
 */
export default function LineupEditor({
  formation,
  assignments,
  squad,
  label,
  hint,
  minutesOf,
  onPick,
  onShuffle,
  footer,
}: Props) {
  const [picking, setPicking] = useState<SlotId | null>(null)

  const byId = new Map(squad.map((p) => [p.id, p]))
  const placed = new Set(Object.values(assignments))
  const bench = squad
    .filter((p) => !placed.has(p.id))
    .sort((a, b) => a.firstName.localeCompare(b.firstName))

  const fill: Partial<Record<SlotId, SlotFill>> = {}
  for (const [slotId, playerId] of Object.entries(assignments)) {
    const p = byId.get(playerId)
    if (!p) continue
    fill[slotId] = {
      name: displayName(p, squad),
      ...(minutesOf ? { mins: minutesOf(playerId) } : {}),
    }
  }

  const slot = picking ? formation.slots.find((x) => x.id === picking) : undefined
  const isKeeperSlot = slot?.requiredRole === 'GK'
  const current = picking ? assignments[picking] : undefined

  // The goal needs someone who will actually go in it.
  const candidates = squad
    .filter((p) => (isKeeperSlot ? p.gk !== 'never' : true))
    .sort((a, b) => a.firstName.localeCompare(b.firstName))

  return (
    <>
      <div className="lineup-head">
        <div>
          <div className="field-label">{label}</div>
          {hint ? <div className="dim">{hint}</div> : null}
        </div>
        {onShuffle ? (
          <button type="button" className="btn" onClick={onShuffle}>
            ↻ Shuffle
          </button>
        ) : null}
      </div>

      <Pitch formation={formation} fill={fill} onSlotClick={(sl) => setPicking(sl.id)} />

      <div className="bench-strip">
        <div className="bench-row">
          <span className="lab">Bench</span>
          {bench.map((p) => (
            <span key={p.id} className="bchip2">
              {displayName(p, squad)}
              {minutesOf ? <em>{minutesOf(p.id)}</em> : null}
            </span>
          ))}
          {bench.length === 0 ? <span className="dim">Everyone is on</span> : null}
        </div>
      </div>

      {footer}

      {picking && slot ? (
        <Sheet
          title={isKeeperSlot ? 'Who goes in goal?' : `Who plays ${slot.label}?`}
          onClose={() => setPicking(null)}
        >
          {isKeeperSlot && candidates.length === 0 ? (
            <div className="dim">
              Nobody on this roster will go in goal. Change that on a player&rsquo;s
              card.
            </div>
          ) : null}
          <div className="card">
            {candidates.map((p) => {
              const here = p.id === current
              const elsewhere = !here && placed.has(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  className="row"
                  onClick={() => {
                    onPick(picking, p.id)
                    setPicking(null)
                  }}
                >
                  <span className="grow">
                    <span className="name">{fullName(p)}</span>
                    <span className="meta">
                      {here
                        ? 'Playing here'
                        : elsewhere
                          ? 'Already on — will swap places'
                          : minutesOf
                            ? `On the bench · ${minutesOf(p.id)} played`
                            : 'On the bench'}
                    </span>
                  </span>
                  {here ? <span className="chev">✓</span> : null}
                </button>
              )
            })}
          </div>
        </Sheet>
      ) : null}
    </>
  )
}
