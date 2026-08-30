import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'

interface Props {
  title: string
  sub?: string
  back?: string | true
  action?: ReactNode
}

export default function AppBar({ title, sub, back, action }: Props) {
  const nav = useNavigate()
  return (
    <header className="bar">
      {back ? (
        <button
          type="button"
          aria-label="Back"
          onClick={() => (back === true ? nav(-1) : nav(back))}
        >
          ‹ Back
        </button>
      ) : null}
      <h1>
        {title}
        {sub ? <span className="sub">{sub}</span> : null}
      </h1>
      {action}
    </header>
  )
}
