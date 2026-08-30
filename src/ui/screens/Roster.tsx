import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { addPlayer, db, deletePlayer, updatePlayer } from '@/db/db'
import type { GkWillingness, PositionGroup, Player } from '@/domain/types'
import AppBar from '../components/AppBar'
import Sheet from '../components/Sheet'

const FIELD_GROUPS: PositionGroup[] = ['DEF', 'MID', 'FWD']
const GROUP_SHORT: Record<PositionGroup, string> = {
  GK: 'Keeper',
  DEF: 'Def',
  MID: 'Mid',
  FWD: 'Fwd',
}

const GK_OPTIONS: { value: GkWillingness; label: string }[] = [
  { value: 'never', label: 'Never' },
  { value: 'willing', label: 'Willing' },
  { value: 'preferred', label: 'Prefers it' },
]

function summarise(p: Player): string {
  const bits: string[] = []
  if (p.gk === 'preferred') bits.push('Keeper')
  else if (p.gk === 'never') bits.push('No goal')
  if (p.preferredGroups.length)
    bits.push(p.preferredGroups.map((g) => GROUP_SHORT[g]).join('/'))
  if (p.avoidGroups.length)
    bits.push(`not ${p.avoidGroups.map((g) => GROUP_SHORT[g]).join('/')}`)
  if (!p.active) bits.push('inactive')
  return bits.join(' · ') || 'No constraints'
}

export default function Roster() {
  const { teamId = '' } = useParams()
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const players = useLiveQuery(
    () => db.players.where('teamId').equals(teamId).sortBy('name'),
    [teamId],
  )

  const [editing, setEditing] = useState<Player | null>(null)
  const [adding, setAdding] = useState(false)
  const [newName, setNewName] = useState('')

  async function createPlayer() {
    const n = newName.trim()
    if (!n) return
    const p = await addPlayer(teamId, n)
    setNewName('')
    setAdding(false)
    setEditing(p)
  }

  const sorted = (players ?? []).slice().sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return (
    <>
      <AppBar
        title="Roster"
        sub={team?.name}
        back={`/team/${teamId}`}
        action={
          <button type="button" onClick={() => setAdding(true)} aria-label="Add player">
            + Player
          </button>
        }
      />
      <main>
        {players === undefined ? null : sorted.length === 0 ? (
          <div className="empty">
            <strong>No players yet</strong>
            Add everyone on the team. You can set who plays in goal and who avoids
            which positions afterwards.
            <div className="btn-row" style={{ marginTop: '1.2rem' }}>
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                Add your first player
              </button>
            </div>
          </div>
        ) : (
          <div className="card">
            {sorted.map((p) => (
              <button
                key={p.id}
                type="button"
                className="row"
                onClick={() => setEditing(p)}
                style={p.active ? undefined : { opacity: 0.55 }}
              >
                <span className={`num-badge${p.gk === 'preferred' ? ' gk' : ''}`}>
                  {p.number ?? p.name.slice(0, 1).toUpperCase()}
                </span>
                <span className="grow">
                  <span className="name">{p.name}</span>
                  <span className="meta">{summarise(p)}</span>
                </span>
                <span className="chev" aria-hidden="true">
                  ›
                </span>
              </button>
            ))}
          </div>
        )}

        {sorted.length > 0 ? (
          <div className="dim" style={{ marginTop: '0.9rem', padding: '0 0.2rem' }}>
            {sorted.filter((p) => p.active).length} active ·{' '}
            {sorted.filter((p) => p.active && p.gk !== 'never').length} will go in goal
          </div>
        ) : null}
      </main>

      {adding ? (
        <Sheet title="Add player" onClose={() => setAdding(false)}>
          <label className="field">
            <span>Name</span>
            <input
              type="text"
              autoFocus
              value={newName}
              placeholder="First name is usually enough"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createPlayer()
              }}
            />
          </label>
          <button
            type="button"
            className="btn primary wide"
            disabled={!newName.trim()}
            onClick={() => void createPlayer()}
          >
            Add
          </button>
        </Sheet>
      ) : null}

      {editing ? (
        <PlayerEditor
          key={editing.id}
          player={editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------- editor

function PlayerEditor({ player, onClose }: { player: Player; onClose: () => void }) {
  const [p, setP] = useState<Player>(player)

  function patch(next: Partial<Player>) {
    const merged = { ...p, ...next }
    setP(merged)
    void updatePlayer(p.id, next)
  }

  /** Preferred and avoid are mutually exclusive per group — picking one clears the other. */
  function toggleGroup(list: 'preferredGroups' | 'avoidGroups', g: PositionGroup) {
    const other = list === 'preferredGroups' ? 'avoidGroups' : 'preferredGroups'
    const has = p[list].includes(g)
    patch({
      [list]: has ? p[list].filter((x) => x !== g) : [...p[list], g],
      [other]: p[other].filter((x) => x !== g),
    } as Partial<Player>)
  }

  async function remove() {
    if (!confirm(`Remove ${p.name} from the roster?`)) return
    await deletePlayer(p.id)
    onClose()
  }

  return (
    <Sheet title={p.name || 'Player'} onClose={onClose}>
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          value={p.name}
          onChange={(e) => patch({ name: e.target.value })}
        />
      </label>

      <label className="field">
        <span>Shirt number</span>
        <input
          type="number"
          inputMode="numeric"
          value={p.number ?? ''}
          placeholder="Optional"
          onChange={(e) =>
            patch({ number: e.target.value === '' ? undefined : Number(e.target.value) })
          }
        />
      </label>

      <div className="field">
        <span
          style={{
            display: 'block',
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            marginBottom: '0.3rem',
          }}
        >
          Goalkeeper
        </span>
        <div className="chips">
          {GK_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              className="chipbtn"
              aria-pressed={p.gk === o.value}
              onClick={() => patch({ gk: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
        <div className="dim" style={{ marginTop: '0.4rem' }}>
          Time in goal counts as playing time, so keepers are kept fair by rotating who
          goes in — not by discounting their minutes.
        </div>
      </div>

      <div className="field">
        <span
          style={{
            display: 'block',
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            marginBottom: '0.3rem',
          }}
        >
          Prefers
        </span>
        <div className="chips">
          {FIELD_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              className="chipbtn"
              aria-pressed={p.preferredGroups.includes(g)}
              onClick={() => toggleGroup('preferredGroups', g)}
            >
              {GROUP_SHORT[g]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span
          style={{
            display: 'block',
            fontSize: '0.72rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--ink-3)',
            marginBottom: '0.3rem',
          }}
        >
          Avoids
        </span>
        <div className="chips">
          {FIELD_GROUPS.map((g) => (
            <button
              key={g}
              type="button"
              className="chipbtn avoid"
              aria-pressed={p.avoidGroups.includes(g)}
              onClick={() => toggleGroup('avoidGroups', g)}
            >
              {GROUP_SHORT[g]}
            </button>
          ))}
        </div>
        <div className="dim" style={{ marginTop: '0.4rem' }}>
          A soft preference. If nobody else is available the planner will still use them
          rather than leave the position empty.
        </div>
      </div>

      <label className="field">
        <span>Max shifts in a row</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={p.maxConsecutiveShifts ?? ''}
          placeholder="Team default"
          onChange={(e) =>
            patch({
              maxConsecutiveShifts:
                e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </label>

      <label className="field">
        <span>Notes</span>
        <textarea
          value={p.notes ?? ''}
          placeholder="Tweaked ankle Tuesday · carpools with Mia"
          onChange={(e) => patch({ notes: e.target.value })}
        />
      </label>

      <div className="field">
        <button
          type="button"
          className="chipbtn"
          aria-pressed={p.active}
          onClick={() => patch({ active: !p.active })}
        >
          {p.active ? 'On the roster' : 'Inactive'}
        </button>
      </div>

      <div className="btn-row">
        <button type="button" className="btn danger" onClick={() => void remove()}>
          Remove from roster
        </button>
      </div>
    </Sheet>
  )
}
