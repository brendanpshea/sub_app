import { useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import type { GameRules } from '@/domain/types'
import AppBar from '../components/AppBar'
import MatchRules from '../components/MatchRules'

export default function TeamRules() {
  const { teamId = '' } = useParams()
  const team = useLiveQuery(() => db.teams.get(teamId), [teamId])

  async function patch(next: Partial<GameRules>) {
    if (!team) return
    await db.teams.update(teamId, { rules: { ...team.rules, ...next } })
  }

  if (!team) return <AppBar title="Match rules" back={`/team/${teamId}`} />

  return (
    <>
      <AppBar title="Match rules" sub={team.name} back={`/team/${teamId}`} />
      <main>
        <MatchRules rules={team.rules} onChange={(p) => void patch(p)} />
        <div className="dim" style={{ marginTop: '1rem', padding: '0 0.2rem' }}>
          New games start from these. Changing them here leaves games already
          created alone.
        </div>
      </main>
    </>
  )
}
