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
    attendance.ts   status/window invariants, roster reconciliation
    planner.ts      three-pass shift chart generator + re-planning
    live.ts         clock, minutes and stats derived from the event log
  db/         Dexie schema, CRUD, event log, JSON export/import
  ui/
    hooks/          useNow, useWakeLock
    components/     AppBar, Pitch, Sheet
    screens/        Teams, TeamDetail, Roster, FormationPicker,
                    Games, GameSetup, PlanGrid, Live, Backup
```

## The planner

Greedy plus a cheap repair pass, not a constraint solver — it runs in
milliseconds, which is what makes the re-roll button feel instant.

1. **Keepers**, at period granularity. Children need a whole quarter to settle
   into goal, and it is the tightest constraint. Ordered by fewest goalkeeping
   periods this season.
2. **Field slots**, deficit-greedy, tightest slots first. `WEIGHTS` in
   `planner.ts` is the whole of the intelligence and is meant to be tuned
   against real rosters.
3. **Repair**, a bounded local search that closes the remaining spread.

Two properties worth knowing:

**Rolling subs are emergent.** There is no scheduler for them. A continuity
bonus for staying in the same slot, against a deficit term that dominates,
means only the two or three most-played children get displaced at each
boundary and everyone else stays put.

**Avoided positions are a tier, not a weight.** The spec originally scored
"avoids defence" as a penalty, but any penalty small enough to be overridable
gets overridden by a two-minute deficit — and a coach who watches their stated
constraint quietly lose a vote stops trusting the planner. Avoiders are now
only considered when nobody else can take the slot, which is what "relaxes when
the pool empties" should have meant.

## Live mode

The sub sheet is open exactly when the field does not match the plan for the
current shift. Nothing else tracks whether a substitution is outstanding.

That one rule does a surprising amount of work. **Confirm** makes the field
match the plan. **Skip** makes the plan match the field. An unplanned
substitution for an injury re-plans the remainder, which makes the plan match
the field again. In every case the sheet closes because the condition that
opened it is gone, and the plan and reality are never allowed to drift apart
silently.

Shift boundaries are period-relative, not cumulative: a referee who plays two
extra minutes in the first quarter must not push every later shift out of
alignment with the quarter it belongs to.

Keep `domain/` free of React. The planner and the derivations are pure functions
over plain data — and they are the parts where a bug quietly costs a child
playing time.

## Status

Built: the whole match-day path. Team, roster with constraints, formation
presets, games and attendance, the planner, the plan grid with pinning and
re-roll, live mode with the clock, substitutions, self-healing re-plans and
basic stats, backup and restore.

Next: the season ledger and the post-game share card, then PNG icons so it
installs properly on a phone.
