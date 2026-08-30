import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { addPlayer, db, deletePlayer, rosterOf, updatePlayer } from '@/db/db'
import type { GkWillingness, PositionGroup, Player } from '@/domain/types'
import { fullName, nameSortKey } from '@/domain/types'
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
  if (!p.active) bits.push('Inactive')
  return bits.join(' · ') || 'No constraints'
}

function FieldLabel({ children }: { children: string }) {
  return <div className="field-label">{children}</div>
}

export default function Roster() {
  const { teamId = '' } = useParams()
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])
  const players = useLiveQuery(() => rosterOf(teamId), [teamId])

  const [editing, setEditing] = useState<Player | null>(null)
  const [adding, setAdding] = useState(false)
  const [first, setFirst] = useState('')
  const [last, setLast] = useState('')

  async function createPlayer() {
    const f = first.trim()
    if (!f) return
    await addPlayer(teamId, f, last)
    setFirst('')
    setLast('')
  }

  const sorted = (players ?? []).slice().sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1
    return nameSortKey(a).localeCompare(nameSortKey(b))
  })

  const active = sorted.filter((p) => p.active)

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
            Add everyone on the team. Positions and goalkeeping come after.
            <div className="btn-row" style={{ marginTop: '1.2rem' }}>
              <button type="button" className="btn primary" onClick={() => setAdding(true)}>
                Add a player
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
                  {p.number ?? p.firstName.charAt(0).toUpperCase()}
                </span>
                <span className="grow">
                  <span className="name">{fullName(p)}</span>
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
            {active.length} active · {active.filter((p) => p.gk !== 'never').length} can
            go in goal
          </div>
        ) : null}
      </main>

      {adding ? (
        <Sheet
          title="Add players"
          onClose={() => {
            setAdding(false)
            setFirst('')
            setLast('')
          }}
        >
          <label className="field">
            <span>First name</span>
            <input
              type="text"
              autoFocus
              value={first}
              onChange={(e) => setFirst(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createPlayer()
              }}
            />
          </label>
          <label className="field">
            <span>Last name — optional</span>
            <input
              type="text"
              value={last}
              onChange={(e) => setLast(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createPlayer()
              }}
            />
          </label>
          <button
            type="button"
            className="btn primary wide"
            disabled={!first.trim()}
            onClick={() => void createPlayer()}
          >
            Add
          </button>
          <div className="dim" style={{ marginTop: '0.6rem', textAlign: 'center' }}>
            The sheet stays open so you can add the whole squad.
          </div>
        </Sheet>
      ) : null}

      {editing ? (
        <PlayerEditor
          key={editing.id}
          player={editing}
          squad={sorted}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------- editor

function PlayerEditor({
  player,
  squad,
  onClose,
}: {
  player: Player
  squad: Player[]
  onClose: () => void
}) {
  const [p, setP] = useState<Player>(player)

  function patch(next: Partial<Player>) {
    setP({ ...p, ...next })
    void updatePlayer(p.id, next)
  }

  /** Prefers and avoids are mutually exclusive — picking one clears the other. */
  function toggleGroup(list: 'preferredGroups' | 'avoidGroups', g: PositionGroup) {
    const other = list === 'preferredGroups' ? 'avoidGroups' : 'preferredGroups'
    const has = p[list].includes(g)
    patch({
      [list]: has ? p[list].filter((x) => x !== g) : [...p[list], g],
      [other]: p[other].filter((x) => x !== g),
    } as Partial<Player>)
  }

  async function remove() {
    if (!confirm(`Remove ${fullName(p)} from the roster?`)) return
    await deletePlayer(p.id)
    onClose()
  }

  const sharesFirstName = squad.some(
    (o) => o.id !== p.id && o.firstName.toLowerCase() === p.firstName.toLowerCase(),
  )

  return (
    <Sheet title={fullName(p) || 'Player'} onClose={onClose}>
      <label className="field">
        <span>First name</span>
        <input
          type="text"
          value={p.firstName}
          onChange={(e) => patch({ firstName: e.target.value })}
        />
      </label>

      <label className="field">
        <span>Last name — optional</span>
        <input
          type="text"
          value={p.lastName ?? ''}
          onChange={(e) => patch({ lastName: e.target.value || undefined })}
        />
      </label>

      {sharesFirstName ? (
        <div className="dim" style={{ marginTop: '-0.4rem', marginBottom: '0.8rem' }}>
          {p.lastName
            ? `Shown as “${p.firstName} ${p.lastName.charAt(0).toUpperCase()}.” during a game.`
            : `Another ${p.firstName} is on this team. Add a last name to tell them apart.`}
        </div>
      ) : null}

      <label className="field">
        <span>Shirt number — optional</span>
        <input
          type="number"
          inputMode="numeric"
          value={p.number ?? ''}
          onChange={(e) =>
            patch({ number: e.target.value === '' ? undefined : Number(e.target.value) })
          }
        />
      </label>

      <div className="field">
        <FieldLabel>Goalkeeper</FieldLabel>
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
        <div className="dim">Time in goal counts as playing time.</div>
      </div>

      <div className="field">
        <FieldLabel>Prefers</FieldLabel>
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
        <FieldLabel>Avoids</FieldLabel>
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
        <div className="dim">Used only if nobody else can take the position.</div>
      </div>

      <label className="field">
        <span>Max shifts in a row — optional</span>
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
