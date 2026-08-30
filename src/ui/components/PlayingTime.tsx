import type { LiveState } from '@/domain/live'
import { outfieldPlayed } from '@/domain/live'
import type { ID, Player } from '@/domain/types'
import { fullName } from '@/domain/types'
import { minutes, mmss } from '@/domain/fairness'

interface Props {
  state: LiveState
  roster: Player[]
  /** Share of *field* time each player should have had. */
  share: Map<ID, number>
}

/**
 * Who played how long.
 *
 * The plus-or-minus is measured on field time, because that is what the team
 * shares out; goal duty is its own rotation and appears as a separate term. A
 * keeper reading "+7:00 over" would be a reproach for doing exactly what was
 * asked of them.
 */
export default function PlayingTime({ state, roster, share }: Props) {
  const out = outfieldPlayed(state)
  const sorted = [...roster].sort(
    (a, b) => (state.playedSec.get(b.id) ?? 0) - (state.playedSec.get(a.id) ?? 0),
  )

  return (
    <div className="card">
      {sorted.map((p) => {
        const gk = state.gkSec.get(p.id) ?? 0
        const field = out.get(p.id) ?? 0
        const dev = field - (share.get(p.id) ?? 0)
        const tone = Math.abs(dev) <= 100 ? 'ok' : dev < 0 ? 'owed' : 'over'
        return (
          <div className="final-line" key={p.id}>
            <span>{fullName(p)}</span>
            <b>
              {minutes(field)}
              {gk > 30 ? <span className="dim"> + {minutes(gk)} goal</span> : null}{' '}
              <span className={`deficit ${tone}`}>
                {dev >= 0 ? '+' : '−'}
                {mmss(Math.abs(dev))}
              </span>
            </b>
          </div>
        )
      })}
      {sorted.length === 0 ? (
        <div className="pad dim">Nobody played.</div>
      ) : null}
    </div>
  )
}
