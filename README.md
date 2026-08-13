# outbound-dialer-scheduler

A call-pacing and scheduling engine for outbound campaigns. It enforces
regulatory time-of-day and contact-frequency constraints while trying to keep
agents busy, and it never trades compliance for utilization.

## The problem

Outbound calling is constrained two independent ways at once:

- **Legally**: recipients can only be called inside a permitted local-time
  window, and only up to some number of times per rolling period.
- **Operationally**: you only have so many agents/lines, and predicting how
  many calls to place ahead of agent availability is what actually determines
  whether those agents sit idle or get overrun with answered calls nobody is
  free to take.

Naive implementations tend to fail in one of two directions: schedule/dial
without real timezone awareness and quietly violate calling-hour or
frequency-cap rules under load, or dial so conservatively that agents sit
idle rather than risk it. This project treats compliance as a hard
constraint (verified programmatically, not sampled) and treats utilization as
an optimization problem constrained by an abandon-rate ceiling, not the other
way around.

## Architecture and design decisions

```
Contacts + campaign config
        │
        ▼
 TimezoneService ──── NPA→IANA lookup table (deny-by-default on ambiguity)
        │
        ▼
 ScheduleGeneratorService ──── walks the horizon in slot increments,
        │                       checking ComplianceService (calling window)
        │                       and LedgerService (frequency cap) at
        │                       *decision* time, before ever handing the
        │                       call off
        ▼
 LedgerService (SQLite) ──── contact_history (frequency ledger)
        │                     audit_log (compliance-input trail)
        ▼
 PacingService (@nestjs/schedule) ── live interval-driven dial-queue
                                       release, paced by predictive-dialing
                                       math (see pacing-simulator.ts)
```

### Why NestJS/Node instead of the original Python/FastAPI/Celery spec

This is a portfolio-series repo where the stack is the repo owner's explicit
choice, not derived from the original spec. The domain logic (timezone
resolution, compliance windows, frequency-cap ledger, predictive pacing) is
stack-agnostic; what NestJS buys here specifically is `@nestjs/schedule` as a
first-class, dependency-injected interval/cron driver for the dial-queue
loop, which maps onto the same role Celery Beat would have played, without
introducing a second process/broker (Redis, in Celery's typical setup) for
what is, in this project's scope, a single-process scheduler. The tradeoff
being accepted: Celery's distributed task queue is more battle-tested for
horizontally-scaled, multi-worker dialing fleets than an in-process Nest
interval; that's a real limitation of this choice, not a wash (see
Limitations).

### Timezone resolution: deny-by-default, not best-effort

`src/timezone/npa-timezone-table.ts` maps North American Numbering Plan
(NANP) area codes to IANA timezones -- real public NANP data, chosen
specifically to cover every DST edge case: standard DST-observing zones,
Arizona (Mountain offset, no DST), Hawaii (no DST), and Newfoundland (a real
UTC-3:30 half-hour offset zone). `TimezoneService.resolve()` returns
`{ timezone: null, isAmbiguous: true }` -- not a guess -- whenever:

- the number is flagged `ported` (a ported number may have moved to a
  carrier/region far from its original area code; without a real NPAC/LRN
  dip, the area code can't be trusted), or
- the area code isn't in the table, or
- the number doesn't parse as NANP at all.

**Rejected alternative**: falling back to a default timezone (e.g. the
campaign's configured "home" zone) for unresolvable numbers. That would let
the scheduler silently place calls outside a recipient's actual legal
window. Deny-by-default means those contacts get rejected with an audit
trail instead -- fewer contacts scheduled, but zero unverified compliance
risk.

**Rejected alternative**: a real telco NPAC/LRN lookup service. Out of
scope/cost for a portfolio project; the interface (`TimezoneService.resolve`)
is the seam where that would plug in for production use.

### Compliance windows: real IANA-aware, not fixed-UTC-offset

`ComplianceService.isWithinCallWindow()` converts the candidate UTC instant
into the recipient's IANA zone via `luxon` (full tz database, DST rules
included) and checks the resulting local hour against the calling window
(default 8:00am-9:00pm local, `[startHour, endHour)`). Because the offset is
recomputed at the specific instant being checked rather than assumed fixed
per zone, this is correct across a DST transition without special-casing --
see `test/compliance.spec.ts` for boundary tests built on the real 2026 US
DST transition dates (spring-forward 2026-03-08, fall-back 2026-11-01).

### Frequency cap: enforced at scheduling time via a durable ledger

`LedgerService` (SQLite via `better-sqlite3`) is the durable per-number
contact-history ledger. `ScheduleGeneratorService` checks
`countRecentContacts()` (a closed-interval `[windowStart, asOf]` count --
see the doc comment on that method for why the upper bound is inclusive, not
the more conventional half-open range) *before* accepting a candidate slot,
and writes the accepted slot to the ledger *immediately*, before moving to
the next contact. That means the schedule is compliant by construction: a
later scheduling run (or a concurrent campaign targeting the same number)
sees every prior commitment right away. There is no separate "check at dial
time" step to skip, race, or forget.

**Rejected alternative**: a last-second veto at dial time (check the cap
right before dialing, reject if exceeded). This is what the spec explicitly
calls out as insufficient -- it can produce a schedule that *looks* fine but
turns out non-compliant once dial time actually arrives (e.g. two concurrent
campaigns both build schedules against the same stale count). Checking and
reserving atomically at scheduling time avoids that.

**Postgres swap**: `LedgerService` is deliberately the only place SQL lives.
Its constructor takes a `dbPath`; in production that becomes a `pg` pool,
`contact_history`/`audit_log` become real tables via a migration with the
same columns/index as `LedgerService.init()` creates today, and every method
signature stays the same. Nothing above `LedgerService` (scheduling,
compliance, pacing) needs to change. SQLite is a legitimate durable store for
this project's scope (single-process, local dev/test) but has no
cross-process row locking, which is exactly the gap Postgres would close for
a horizontally-scaled dialer fleet.

### Predictive pacing: forecast net capacity, govern by abandon rate

`src/pacing/pacing-simulator.ts` is a discrete-tick simulation (ticks every
`tickSec` seconds). A dialed call resolves (answered or not) after
`meanRingSetupSec`, not instantly -- that delay is the entire reason pacing
is hard: you have to decide how many more calls to dial in the ticks before
you find out whether the last batch connected. Handle time is drawn from an
exponential distribution with mean `meanHandleTimeSec` (the standard
first-order model for handle-time variability).

- **Predictive** strategy: each tick, forecast net *new* capacity =
  currently-idle agents + agents about to free up within one ring-setup
  window - `linesInFlight` (calls already dialed that haven't resolved yet,
  since those are already-committed demand against that same capacity).
  Convert that into a dial count via a **running, observed** answer-rate
  estimate (not the true configured rate -- the pacer only sees its own
  outcomes). If the trailing abandon rate (a real sliding window, not an
  exponential decay -- see the code comment on why that distinction matters
  for avoiding a governor lockup) approaches `abandonRateCeiling`, throughput
  is throttled directly, overriding the forecast.
- **Fixed-ratio** (naive) baseline: dial a constant multiple of
  currently-idle agents every tick. It does not track `linesInFlight`, which
  is exactly the mistake predictive pacing exists to avoid: once ring delay
  lets multiple dial batches overlap, a naive dialer keeps adding new demand
  on top of already-committed demand.

**Rejected alternative**: a full Erlang-C/Erlang-X queueing model. That's the
theoretically "correct" approach real dialers use, but it requires modeling
a request queue with abandonment-while-ringing and is substantially more
machinery than this project's scope calls for. The tick-based simulation
here is simpler and its assumptions are stated up front (see the doc comment
at the top of `pacing-simulator.ts`) rather than hidden behind queueing
theory the reader has to reverse-engineer.

**Rejected alternative** (a real bug found and fixed during development): an
earlier version decayed the abandon-rate governor's numerator and
denominator by the same exponential factor each tick. Once the governor
throttled dialing to zero, no new observations could arrive to correct it --
decaying numerator and denominator together never changes their ratio, so
the governor stayed latched at zero for the rest of the simulation. Fixed by
switching to a true sliding window (a fixed-size ring buffer) that ages out
old ticks regardless of whether new dialing happened. `pacing-simulator.spec.ts`
has a regression test for this specific failure mode.

### Audit log

Every scheduling attempt -- accepted or rejected -- writes exactly one row to
`audit_log` with the timezone source, the frequency count at decision time,
the frequency cap, the decision, and a reason. `test/audit-log.spec.ts`
verifies completeness (one row per attempted contact, every field populated)
directly, not just as a side effect of other tests.

## Setup

```bash
git clone <this-repo>
cd outbound-dialer-scheduler
npm install
npm test        # full suite: constraint sweep, DST boundaries, pacing comparison, audit completeness
npm run demo    # runs a real schedule + pacing comparison, prints output like below
```

Requires Node 18+. No external services or network access needed -- the
ledger is a local SQLite file (`./data/*.sqlite`, gitignored) and the
timezone table is embedded data.

## Usage example (real output)

`npm run demo` builds a 42-contact campaign spanning the 2026-03-08 US
spring-forward DST transition, generates a schedule, then runs the
predictive-vs-fixed-ratio pacing comparison. Actual output from a real run:

```
=== Scheduling demo ===
contacts submitted: 42
scheduled: 36
rejected: 6
rejection reasons: [
  'timezone-ambiguous:ported-ambiguous',
  'timezone-ambiguous:unknown-area-code',
  'timezone-ambiguous:unparseable-number'
]

sample scheduled calls:
  +13125551001 -> 2026-03-06T00:00:00.000Z (local Thu 2026-03-05 18:00 America/Chicago), freq_count_at_decision=0
  +13035551002 -> 2026-03-06T00:00:00.000Z (local Thu 2026-03-05 17:00 America/Denver), freq_count_at_decision=0
  +16025551003 -> 2026-03-06T00:00:00.000Z (local Thu 2026-03-05 17:00 America/Phoenix), freq_count_at_decision=0
  +12135551004 -> 2026-03-06T00:00:00.000Z (local Thu 2026-03-05 16:00 America/Los_Angeles), freq_count_at_decision=0
  +19075551005 -> 2026-03-06T00:00:00.000Z (local Thu 2026-03-05 15:00 America/Anchorage), freq_count_at_decision=0

audit log entries: 42 (== scheduled + rejected: 42)

=== Pacing demo: predictive vs. fixed-ratio ===
strategy                           dialed   answered   handled   abandoned   abandonRate   utilization
predictive (aggressiveness=0.3)      1804        584       584           0         0.00%         97.8%
fixed-ratio (0.2x idle agents)       1722        560       560           0         0.00%         86.6%
fixed-ratio (0.5x idle agents)       2388        786       641         145        18.45%         94.9%
```

Reading this: the conservative naive dialer (0.2x) never breaches the 3%
abandon ceiling, but leaves real capacity idle (86.6% utilization). The
aggressive naive dialer (0.5x) gets closer to full utilization but blows
through the abandon ceiling by more than 6x (18.45% vs 3%) -- exactly the two
failure modes described in the problem statement. Predictive pacing gets
higher utilization than *either* naive configuration (97.8%) while keeping
the abandon rate at 0% by actively forecasting net capacity and backing off
before the ceiling is at risk.

## Testing

```bash
npm test
```

- `test/timezone.spec.ts` -- NPA resolution, deny-by-default for ported/
  unknown/unparseable numbers.
- `test/compliance.spec.ts` -- window boundaries, both real 2026 DST
  transitions (spring-forward gap, fall-back repeated hour), a non-DST zone
  (Arizona) as a negative control.
- `test/ledger.spec.ts` -- ledger persistence and window-boundary semantics.
- `test/schedule-generator.spec.ts` -- exact frequency-cap boundary (the
  cap-th contact is accepted, the (cap+1)-th is rejected), no double-booking.
- `test/constraint-sweep.spec.ts` -- generates a schedule across an
  adversarial contact set (every timezone type in the table, ported/unknown/
  unparseable numbers, repeated numbers to stress the cap) over horizons
  spanning both 2026 DST transitions, then **independently re-derives**
  (without calling back into the code under test) whether any scheduled call
  violates the time window or frequency cap. Asserts zero violations.
- `test/pacing-simulator.spec.ts` -- predictive vs. fixed-ratio comparison
  with real numbers, determinism given a fixed seed, and a regression test
  for the governor-lockup bug described above.
- `test/audit-log.spec.ts` -- one audit row per attempted contact, every
  compliance-input field populated, for both accepted and rejected outcomes.

## Limitations

- **Timezone data** is a representative subset of NANP area codes (~30),
  not the full table (~350), chosen to cover every DST/offset edge case
  rather than every area code. Extending the table is a data problem, not an
  architecture change.
- **Pacing model** is a simplified discrete-tick simulation, not full
  Erlang-C/Erlang-X queueing: single call-outcome class, homogeneous agents,
  deterministic ring-setup rounding to whole ticks, and no time-varying
  answer rate within a shift. See the doc comment at the top of
  `pacing-simulator.ts` for the complete list.
- **SQLite**, not Postgres, per this project's stated scope -- see the
  "Postgres swap" note above for what changes and what doesn't.
- **Single-process** scheduler/pacer. `@nestjs/schedule`'s interval driver
  doesn't coordinate across multiple Nest instances; a horizontally-scaled
  deployment would need either a distributed lock around the ledger writes
  or a real task queue (which is exactly the role Celery would have played
  in the original spec).

## License

MIT, see `LICENSE`.
