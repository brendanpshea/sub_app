# Touchline

Substitutions, playing time and stats for youth soccer, run from the sideline.

Offline-first installable web app. No backend, no accounts — everything lives in
IndexedDB on the device, because fields have no signal.

## Running it

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # domain tests
npm run build      # production bundle + service worker
```

## Deploying

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The workflow typechecks and runs the tests
first, so a broken fair-share calculation cannot reach the field.

One-time setup on the repo: **Settings → Pages → Build and deployment →
Source: GitHub Actions**.

The build uses a relative `base`, so the same artifact works from the dev
server, from `vite preview`, and from a project site at `/<repo>/` without the
repo name appearing anywhere in the config. Routing is hash-based, so deep
links survive the subpath and no SPA fallback is needed.

## The two rules that shape the code

**1. The plan is disposable; the event log is truth.**
A plan is a schedule of intentions. Because substitutions happen at stoppages,
the plan says 6:00 and the swap lands at 6:23 — every time, all season. So every
number in the app (minutes, deficits, the season ledger) is *derived* from an
append-only event log, never accumulated into a counter. Undo is trivial,
retroactive clock corrections recompute correctly, and mid-game re-planning is
just calling the planner again with real minutes as its starting state.

**2. Goalkeeper minutes count like every other minute.**
Time in goal is playing time. There is no weighted ledger. Keeper equity comes
from *rotation* — the planner orders the keeper pool by fewest goalkeeping
periods this season — not from discounting anyone's minutes.

## Fair share

A player who arrives late gets an even share of what remains, not a debt the
rest of the team pays back:

```
fairShare(p) = Σ over intervals where p is available:
                 duration × min(playersOnField, available) / available
```

Ten players, 7v7, 40 minutes, one arriving at halftime: the nine early arrivals
target 29.6 minutes each, the late arrival 14.0, and the total is exactly
`7 × 40` player-minutes. Because 14.0 *was* their fair share, the late arrival
finishes with zero deficit and carries nothing into next week. See
`src/domain/fairness.test.ts`.

## Layout

```
src/
  domain/     pure, React-free, unit-tested
    types.ts        the model
    formations.ts   7v7 preset library + pitch coordinates
    fairness.ts     fair share, shift grid, formatting
  db/         Dexie schema, CRUD, JSON export/import
  ui/
    components/     AppBar, Pitch, Sheet
    screens/        Teams, TeamDetail, Roster, FormationPicker, Backup
```

Keep `domain/` free of React. The planner and the derivations are pure functions
over plain data — and they are the parts where a bug quietly costs a child
playing time.

## Status

Built: data layer, roster with constraints, formation presets, backup/restore.

Next: games and attendance, then the planner and the plan grid, then live mode.
