import type { GameRules } from '@/domain/types'
import { gameLengthSec } from '@/domain/types'
import { buildShiftGrid } from '@/domain/fairness'
import {
  goalIsOrdinaryPosition,
  keeperStintShifts,
  shiftLengthSec,
  shiftsPerPeriod,
} from '@/domain/planner'

interface Preset {
  label: string
  periodCount: number
  periodMinutes: number
}

/** The formats youth soccer actually plays. */
const PRESETS: Preset[] = [
  { label: '4 × 10', periodCount: 4, periodMinutes: 10 },
  { label: '4 × 12', periodCount: 4, periodMinutes: 12 },
  { label: '2 × 20', periodCount: 2, periodMinutes: 20 },
  { label: '2 × 25', periodCount: 2, periodMinutes: 25 },
  { label: '2 × 30', periodCount: 2, periodMinutes: 30 },
  { label: '4 × 15', periodCount: 4, periodMinutes: 15 },
]

export default function MatchRules({
  rules,
  onChange,
}: {
  rules: GameRules
  onChange: (patch: Partial<GameRules>) => void
}) {
  const totalMin = gameLengthSec(rules) / 60
  const shifts = buildShiftGrid(rules)
  const perPeriod = shifts.filter((s) => s.period === 1).length
  const shiftLen = shifts[0] ? (shifts[0].endSec - shifts[0].startSec) / 60 : 0
  const ordinary = goalIsOrdinaryPosition(rules)
  const shiftMin = shiftLengthSec(rules) / 60
  const gkPerPeriod = shiftsPerPeriod(rules)
  const stints = keeperStintShifts(rules)
  const stintList = [...new Set(stints.map((n) => Math.round(n * shiftMin)))]
    .sort((a, b) => a - b)
    .join(' and ')
  const keeperHint = ordinary
    ? `${stints.length} turn${stints.length === 1 ? '' : 's'} in goal each period, of ${stintList} min. Goal minutes count like any other.`
    : stints[0] === gkPerPeriod * rules.periodCount
      ? 'One keeper for the whole game.'
      : `One keeper a period, ${rules.periodMinutes} min each. Changes only at the break.`

  /**
   * Stint lengths worth offering: whole numbers of substitution blocks that
   * still leave at least two turns in a period, then whole periods.
   */
  const keeperChoices: { label: string; minutes: number }[] = []
  for (let n = 1; gkPerPeriod >= 2 * n; n++) {
    keeperChoices.push({ label: `${Math.round(n * shiftMin)} min`, minutes: Math.round(n * shiftMin) })
  }
  for (let i = 1; i <= rules.periodCount; i++) {
    const minutes = i * rules.periodMinutes
    if (keeperChoices.some((c) => c.minutes === minutes)) continue
    keeperChoices.push({ label: i === 1 ? '1 period' : `${i} periods`, minutes })
  }
  const keeperMinutes = Math.round(rules.gkMinMinutes ?? rules.periodMinutes)

  return (
    <>
      <div className="summary">
        <span className="big">{totalMin}</span>
        <span className="cap">
          minute game · {rules.periodCount} ×{' '}
          {rules.periodCount === 2 ? 'halves' : 'quarters'} of {rules.periodMinutes} min
        </span>
      </div>

      <div className="card pad">
        <div className="field-label">Format</div>
        <div className="chips">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              className="chipbtn"
              aria-pressed={
                rules.periodCount === p.periodCount &&
                rules.periodMinutes === p.periodMinutes
              }
              onClick={() =>
                onChange({
                  periodCount: p.periodCount,
                  periodMinutes: p.periodMinutes,
                })
              }
            >
              {p.label}
            </button>
          ))}
        </div>

        <div style={{ marginTop: '1.1rem' }}>
          <Stepper
            label="Periods"
            value={rules.periodCount}
            min={1}
            max={4}
            onChange={(v) => onChange({ periodCount: v })}
          />
          <Stepper
            label="Minutes each"
            value={rules.periodMinutes}
            min={5}
            max={45}
            onChange={(v) => onChange({ periodMinutes: v })}
          />
          <Stepper
            label="Players on the field"
            value={rules.playersOnField}
            min={3}
            max={11}
            onChange={(v) => onChange({ playersOnField: v })}
          />
          <div style={{ marginBottom: '0.9rem' }}>
            <div className="field-label">Keeper stays in goal for</div>
            <div className="chips">
              {keeperChoices.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  className="chipbtn"
                  aria-pressed={keeperMinutes === c.minutes}
                  onClick={() => onChange({ gkMinMinutes: c.minutes })}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="dim" style={{ marginTop: '0.3rem' }}>
              {keeperHint}
            </div>
          </div>

          <Stepper
            label="Most shifts in a row"
            value={rules.maxConsecutiveShifts}
            min={1}
            max={12}
            onChange={(v) => onChange({ maxConsecutiveShifts: v })}
            hint={`A player comes off after ${rules.maxConsecutiveShifts} block${
              rules.maxConsecutiveShifts === 1 ? '' : 's'
            } at most. Relaxed only when there is nobody left to bring on.`}
          />
          <Stepper
            label="Sub every (minutes)"
            value={rules.shiftMinutes}
            min={1}
            max={15}
            onChange={(v) => onChange({ shiftMinutes: v })}
            hint={`${perPeriod} shifts per period, about ${shiftLen.toFixed(1)} min each.`}
          />
        </div>
      </div>
    </>
  )
}

function Stepper({
  label,
  value,
  min,
  max,
  step = 1,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <div style={{ marginBottom: '0.9rem' }}>
      <div className="field-label">{label}</div>
      <div className="stepper">
        <button
          type="button"
          aria-label={`Fewer ${label}`}
          disabled={value <= min}
          onClick={() => onChange(Math.max(min, value - step))}
        >
          −
        </button>
        <span className="val">{value}</span>
        <button
          type="button"
          aria-label={`More ${label}`}
          disabled={value >= max}
          onClick={() => onChange(Math.min(max, value + step))}
        >
          +
        </button>
      </div>
      {hint ? <div className="dim" style={{ marginTop: '0.3rem' }}>{hint}</div> : null}
    </div>
  )
}
