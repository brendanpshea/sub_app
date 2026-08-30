import { Navigate, Route, Routes } from 'react-router-dom'
import Teams from './ui/screens/Teams'
import TeamDetail from './ui/screens/TeamDetail'
import Roster from './ui/screens/Roster'
import FormationPicker from './ui/screens/FormationPicker'
import Backup from './ui/screens/Backup'

export default function App() {
  return (
    <div className="app">
      <Routes>
        <Route path="/" element={<Teams />} />
        <Route path="/backup" element={<Backup />} />
        <Route path="/team/:teamId" element={<TeamDetail />} />
        <Route path="/team/:teamId/roster" element={<Roster />} />
        <Route path="/team/:teamId/formation" element={<FormationPicker />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  )
}
