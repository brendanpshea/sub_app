import { useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { BUILT_IN_FORMATIONS } from '@/domain/formations'
import type { PositionGroup } from '@/domain/types'
import AppBar from '../components/AppBar'
import Pitch from '../components/Pitch'

const GROUP_WORD: Record<PositionGroup, string> = {
  GK: 'keeper',
  DEF: 'at the back',
  MID: 'in midfield',
  FWD: 'up top',
}

/** "2 at the back, 3 in midfield, 1 up top" — said the way a coach says it. */
function describe(slots: { group: PositionGroup; requiredRole?: 'GK' }[]): string {
  const order: PositionGroup[] = ['DEF', 'MID', 'FWD']
  return order
    .map((g) => ({ g, n: slots.filter((s) => s.requiredRole !== 'GK' && s.group === g).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${x.n} ${GROUP_WORD[x.g]}`)
    .join(', ')
}

export default function FormationPicker() {
  const { teamId = '' } = useParams()
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])

  async function choose(id: string) {
    await db.teams.update(teamId, { defaultFormationId: id })
  }

  return (
    <>
      <AppBar title="Formation" sub={team?.name} back={`/team/${teamId}`} />
      <main>
        <div className="dim" style={{ padding: '0 0.2rem 0.8rem' }}>
          The shape you usually start in. You can change it for any single game later.
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
            gap: '0.7rem',
          }}
        >
          {BUILT_IN_FORMATIONS.map((f) => {
            const selected = team?.defaultFormationId === f.id
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => void choose(f.id)}
                className="card"
                style={{
                  padding: '0.55rem',
                  cursor: 'pointer',
                  textAlign: 'left',
                  borderColor: selected ? 'var(--accent)' : 'var(--rule)',
                  borderWidth: selected ? 2 : 1,
                  font: 'inherit',
                  color: 'inherit',
                }}
                aria-pressed={selected}
              >
                <Pitch formation={f} />
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '0.4rem',
                    marginTop: '0.5rem',
                  }}
                >
                  <strong style={{ fontSize: '1.05rem' }}>{f.name}</strong>
                  {selected ? (
                    <span
                      style={{
                        fontSize: '0.66rem',
                        fontWeight: 700,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: 'var(--accent)',
                      }}
                    >
                      In use
                    </span>
                  ) : null}
                </div>
                <div className="dim" style={{ fontSize: '0.76rem' }}>
                  {describe(f.slots)}
                </div>
              </button>
            )
          })}
        </div>

        <div className="dim" style={{ marginTop: '1.2rem', padding: '0 0.2rem' }}>
          Building a custom shape by dragging positions around comes later. These five
          cover almost every 7v7 side.
        </div>
      </main>
    </>
  )
}
