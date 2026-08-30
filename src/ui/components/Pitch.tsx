import type { Formation, Slot, SlotId } from '@/domain/types'

export interface SlotFill {
  /** Big text — a player name. Kept largest because it is what you read at a glance. */
  name: string
  /** Optional small line under the name. */
  note?: string
  /** 0..1 share of fair share met, drives the hairline under the name. */
  share?: number
}

interface Props {
  formation: Formation
  fill?: Partial<Record<SlotId, SlotFill>>
  onSlotClick?: (slot: Slot) => void
  /** Show position labels even when a slot has a player in it. */
  alwaysLabel?: boolean
}

export default function Pitch({ formation, fill, onSlotClick, alwaysLabel }: Props) {
  return (
    <div className="pitch">
      <div className="lines" />
      <div className="halfway" />
      <div className="circle" />
      <div className="box own" />
      <div className="box opp" />
      {formation.slots.map((s) => {
        const f = fill?.[s.id]
        const isGk = s.requiredRole === 'GK'
        const cls = ['slot', isGk ? 'gk' : '', f ? '' : 'empty'].filter(Boolean).join(' ')
        return (
          <button
            key={s.id}
            type="button"
            className={cls}
            style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}
            onClick={onSlotClick ? () => onSlotClick(s) : undefined}
            disabled={!onSlotClick}
            aria-label={f ? `${f.name}, ${s.label}` : s.label}
          >
            {f ? (
              <>
                {alwaysLabel ? <span className="lab">{s.label}</span> : null}
                {f.name}
                {f.note ? <span className="lab">{f.note}</span> : null}
              </>
            ) : (
              s.label
            )}
          </button>
        )
      })}
    </div>
  )
}
