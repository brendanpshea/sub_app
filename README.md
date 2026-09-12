# Touchline

Substitutions, playing time and stats for youth soccer, run from the sideline.

**[brendanpshea.github.io/sub_app](https://brendanpshea.github.io/sub_app/)**

Offline-first installable web app. No backend, no accounts — everything lives in
IndexedDB on the device, because fields have no signal.

## What it does

1. **Team and roster.** Per player: whether they will go in goal, positions they
   prefer or avoid, a cap on consecutive shifts. Pairs who must be kept apart.
2. **Match rules.** Periods, length, players on the field, how often to sub, how
   long a keeper stays in goal. Set per team, overridable per game.
3. **Attendance.** Here, late, leaving early, out — with arrival and departure
   set by period rather than by typing seconds.
4. **A shift chart** that gives everyone an even share, with pinning and
   re-rolling, editable cell by cell.
5. **Match day.** A clock that survives a locked phone, a lineup you can
   rearrange at kick-off and at every break, substitution prompts that wait for
   the whistle, position swaps, keeper changes, and late arrivals mid-game.
6. **A recap** of playing time, goals, assists and saves, with the game
   reopenable if the final whistle was a mis-tap.

Backup and restore as JSON, because a lost phone is otherwise a lost season.

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

## The three rules that shape the code

**1. The plan is disposable; the event log is truth.**
A plan is a schedule of intentions. Because substitutions happen at stoppages,
the plan says 6:00 and the swap lands at 6:23 — every time, all season. So every
number in the app (minutes, deficits, who is owed what) is *derived* from an
append-only event log, never accumulated into a counter. Undo is trivial,
retroactive clock corrections recompute correctly, and mid-game re-planning is
just calling the planner again with real minutes as its starting state.

**2. Field time is shared out; goal duty is rotated separately.**
Time in goal neither earns credit nor leaves a debt: a keeper comes out of goal
level with everyone else and takes an even share of what remains. This is not
the obvious choice, and the obvious one is worse. Counting goal time in the same
ledger makes a child's game depend on *when* they kept — keep first and you are
held back for the rest of the match, keep last and you finish well over. Keeping
it separate is symmetric whichever half they take.

The price is that keepers finish ahead on *total* pitch time, since they are on
for their whole stint while the outfielders around them rotate. The gap widens
with squad size: roughly 3 minutes at eight players, 13 at fourteen. Reports say
`13m + 20m goal` rather than a bare `33m`, so the two are never confused.

**3. Nothing is spent on a prediction.**
A player is never sat down early because they are pencilled in to keep goal
later. Plans change — half-time changes them most — and a child who sat for a
stint that never happened gets nothing back. The planner only ever reacts to
goal time that has actually been served.

## Fair share

Two ledgers, and it matters which is which.

**Total field time** — `fairShareSec` — is an even share of every position-minute
in the game. It backs the "about 28 minutes each" estimate on the attendance
screen. A player who arrives late gets an even share of what remains, not a debt
the rest of the team pays back:

```
fairShare(p) = Σ over intervals where p is available:
                 duration × min(playersOnField, available) / available
```

Ten players, 7v7, 40 minutes, one arriving at halftime: the nine early arrivals
target 29.6 minutes each, the late arrival 14.0, and the total is exactly
`7 × 40` player-minutes. Because 14.0 *was* their fair share, the late arrival
finishes with zero deficit and carries nothing into next week.

**Outfield time** — `outfieldShareUpTo` — is the one that actually decides
anything. Same shape, but it shares the *outfield* positions among whoever is
not in goal at that moment. Every "owed" figure, the bench order, the sub sheet
and the recap read from it, and so does the planner. See
`src/domain/fairness.test.ts`.

## The planner

Greedy plus two cheap cleanup passes, not a constraint solver — it runs in
milliseconds, which is what makes the re-roll button feel instant.

1. **Keepers**, a whole block of periods at a time. `gkMinMinutes` sets the
   shortest stint, rounded up to whole periods and never less than one: twenty
   minutes of ten-minute quarters gives two keepers a half each rather than four
   keepers a quarter each. A change can then only land at a period break, never
   at a throw-in. The pool is ordered by fewest goalkeeping periods this season.
2. **Field slots**, deficit-greedy on the outfield ledger, tightest slots first.
   `WEIGHTS` in `planner.ts` is the whole of the intelligence and is meant to be
   tuned against real rosters.
3. **Repair**, a bounded local search that closes the remaining spread.
4. **Smoothing**, which breaks up runs of consecutive shifts on the bench
   without letting anyone's total drift.

Four properties worth knowing:

**The bench rotates whole.** With ten players and three substitutes, all three
go on at each boundary — dribbling two on and making the third wait is what gets
a coach asked "why can't I go in yet?". Nobody sits two shifts running. The
continuity bonus is what stops *more* than the bench rotating, so everyone else
stays put.

**Waiting outranks staying put.** `rested` is 0.9 against `continuity` at 0.35,
and is multiplied by how many shifts a player has already waited. At equal
deficit the child on the bench goes on, and a second consecutive shift waiting
is close to unbeatable. Having these the wrong way round was a real bug.

**Avoided positions are a tier, not a weight.** Any penalty small enough to be
overridable gets overridden by a two-minute deficit — and a coach who watches a
stated constraint quietly lose a vote stops trusting the planner. Avoiders are
only considered when nobody else can take the slot.

**Repair only acts when it helps.** Moving a five-minute shift from a player two
minutes over to one three minutes under just exchanges their places in the
table. A swap is taken only when the gap is wider than the block being moved,
which is the condition under which it actually reduces the imbalance. Without
that test it churned for its whole iteration budget and shredded the rotation.

## Live mode

The sub sheet is open exactly when the field does not match the plan for the
current shift. Nothing else tracks whether a substitution is outstanding.

That one rule does a surprising amount of work. **Confirm** makes the field
match the plan. **Skip** makes the plan match the field. An unplanned
substitution for an injury re-plans the remainder, which makes the plan match
the field again. In every case the sheet closes because the condition that
opened it is gone, and the plan and reality are never allowed to drift apart
silently.

Around that:

- **The goal is left alone during play.** A keeper change is made by tapping the
  keeper, or at a period break — never proposed at a stoppage.
- **A substitution moves only the players being substituted.** Whoever stays on
  keeps the position they are standing in; the player coming on inherits the
  shirt of the one going off. Marching six children around the pitch to satisfy
  a chart is disruptive and buys nothing.
- **Two players already on can trade places**, which is two `MOVE` events, so
  neither leaves the field and neither loses a second.
- **Period breaks open the lineup editor**, the same one as kick-off. At half
  time a coach legitimately reshapes several positions at once, and the
  no-shuffle rule that is right for a throw-in is wrong there.
- **Periods never end on a timer.** The clock runs past the nominal length and
  waits to be told; stoppage time counts.

Shift boundaries are period-relative, not cumulative: a referee who plays two
extra minutes in the first quarter must not push every later shift out of
alignment with the quarter it belongs to.

## Layout

```
src/
  domain/     pure, React-free, unit-tested
    types.ts        the model
    formations.ts   7v7 preset library + pitch coordinates
    fairness.ts     both fair-share ledgers, shift grid, formatting
    attendance.ts   status/window invariants, roster reconciliation
    planner.ts      four-pass shift chart generator + re-planning
    live.ts         clock, minutes and stats derived from the event log
  db/         Dexie schema and migrations
    games.ts        fixtures and attendance
    plans.ts        shift charts and pins
    events.ts       the append-only log, undo, reopening a game
    backup.ts       JSON export/import
  ui/
    hooks/          useNow, useWakeLock
    components/     AppBar, Pitch, Sheet, LineupEditor, MatchRules, PlayingTime
    screens/        Teams, TeamDetail, Roster, FormationPicker, TeamRules,
                    Games, GameSetup, PlanGrid, Live, Recap, Backup
```

Keep `domain/` free of React. The planner and the derivations are pure functions
over plain data — and they are the parts where a bug quietly costs a child
playing time. 124 tests live there; there are none for the UI.

## Status

The whole match-day path works, and has been reviewed end to end but not yet
used in a real game.

Known gaps:

- **No PNG icons.** The manifest points at the SVG favicon, so the home-screen
  icon on Android will be poor until 192/512 maskable PNGs exist.
- **No season ledger.** `carriedDeficit` and `seasonGkPeriods` are accepted by
  the planner but nothing supplies them, so keeper rotation and playing-time
  debt do not carry from one week to the next. Within a game both work.
- **No share card.** The recap is readable but there is nothing to send to a
  team chat.
- **`limited` attendance** is honoured by the domain — it behaves as a combined
  late arrival and early departure — but no screen can set it.
