# Carry research + Armed Entry phase

This branch builds the data, research, decision, and explicitly authorized entry layer required before a full autonomous carry strategy is considered.

It started as a **read-only carry research phase** and now includes a bounded **Carry Armed Entry** capability. Armed Entry is not a new autonomous carry strategy: the user still selects the pair, direction, size, leverage, execution parameters, and carry thresholds, then explicitly arms one opportunity. The backend waits for the configured conditions and, if they are all satisfied, launches the application's existing finite paired-position execution path.

The branch deliberately reuses the existing execution engine rather than creating a second order-placement implementation.

## What this phase is for

The main purpose is to answer four questions with real data before designing a fully autonomous carry bot:

1. **Is the apparent funding opportunity real and persistent?**
   - persist the live funding-rate formation process instead of looking only at the current rate or realized history;
   - distinguish rising, flat, decaying, and insufficient funding states.

2. **Can the position actually be entered at an acceptable price?**
   - use executable short bid / long ask for the live entry basis;
   - compare the current executable basis with the existing historical basis distribution.

3. **Is the expected carry large enough after trading costs?**
   - normalize funding to an 8-hour equivalent;
   - combine funding edge, executable basis, and the account's current execution fees;
   - expose simple break-even and carry-cushion metrics.

4. **Can a human-authorized opportunity wait safely without keeping the browser open?**
   - persist a Carry Armed Entry in SQLite;
   - keep evaluating it in the backend;
   - trigger only after all configured gates pass;
   - keep using the existing Strategy Engine for margin, leverage, instrument, two-leg execution, fill repair, and shutdown safety.

So the phase is not primarily about “writing a carry bot.” It is about creating the **measurement and execution substrate** needed to learn what a profitable carry setup actually looks like in production.

## Current workflow

```text
Funding scanner
  -> paired Position view
       short high-funding venue / long low-funding venue
  -> realized funding history
  -> live funding formation trajectory
  -> executable entry basis
  -> historical basis distribution
  -> fees / break-even / carry cushion
  -> choose one of two actions
       A. manual finite paired execution
       B. explicitly configure + ARM one Carry Entry
  -> existing Strategy Engine performs the actual paired execution
```

The existing native-venue funding-history fetchers and candle backfill remain unchanged.

---

# 1. Funding observations

`CrossExMarketHub` already subscribes to the public `funding_rate` WebSocket channel. The new `FundingObservationStore` listens to the same market stream and persists the funding-rate formation process to SQLite.

Table:

```text
funding_rate_observations
```

Stored fields:

- CrossEx symbol
- backend observation time
- current funding rate
- next funding time
- source

Sampling is bounded:

- persist after at least 30 seconds since the previous sample; or
- persist immediately when the funding rate moves by at least 0.5 bp.

The hub starts with deterministic demo placeholders. The store is primed with those values before the socket starts and will not persist a symbol until a later funding value or next-funding timestamp proves that a real funding-channel update has arrived. This prevents boot placeholders from contaminating research history.

`LiveMarket.updatedAt` is deliberately not used as the funding observation timestamp because it represents ticker/executable-price freshness and does not advance on funding-only frames.

Funding observations are retained for 90 days by normal database maintenance.

## Read-only observation API

```text
POST /api/markets/funding-observations
```

Header:

```text
x-gct-read-intent: funding-observations
```

Example body:

```json
{
  "symbols": [
    "BINANCE_FUTURE_BTC_USDT",
    "OKX_FUTURE_BTC_USDT"
  ],
  "durationHours": 24
}
```

`durationHours` is restricted to 1–72 hours and up to seven symbols are accepted per request. The endpoint reads only local SQLite data; it does not contact an exchange and cannot mutate trading state.

For each symbol it returns the sampled formation points plus:

- current funding rate
- approximately 1-hour-ago and 4-hour-ago rates
- local peak and peak time
- drawdown from the local peak
- 1-hour and 4-hour slopes
- state: `RISING`, `DECAYING`, `FLAT`, or `INSUFFICIENT`

---

# 2. Carry research analytics

The paired Position view now also loads price-difference candles, so the existing `PriceDifferenceHistoryChart` is available for Position research rather than only the continuous price-difference strategy.

The Carry Research Panel shows:

- short / long funding formation trajectories, normalized to an 8-hour equivalent
- current funding edge
- current executable entry basis
- historical basis mean and standard deviation
- basis z-score
- round-trip execution-fee estimate
- one-funding-interval carry cushion
- funding-only fee break-even time
- basis-adjusted fee break-even time

## Executable basis

For a short venue `S` and long venue `L`:

```text
ExecutableBasisBps = (Bid_S - Ask_L) / Ask_L * 10000
```

The Position screen's live pair uses bid / ask when the CrossEx WebSocket quote is live. Historical basis is derived from synchronized candle closes using the application's existing candle history.

They are intentionally different concepts:

- **live executable basis** estimates the spread available to enter now;
- **historical close basis** describes the distribution used for research.

Historical basis is therefore a proxy and does not promise an executable fill.

## Funding edge

After normalizing both venues to an 8-hour equivalent:

```text
FundingEdge = Funding_short - Funding_long
```

Positive values favor the intended short-high / long-low direction before basis and fees.

## Fees and break-even

The research panel uses the configured maker/taker fee for each selected leg.

Simple round-trip estimate:

```text
RoundTripFeeBps = 2 * (Fee_short + Fee_long) * 10000
```

One-interval carry cushion:

```text
CarryCushionBps = FundingEdgeBps + ExecutableBasisBps - RoundTripFeeBps
```

The basis-adjusted break-even calculation assumes the entry basis eventually exits at zero. It is a research scenario, not a forecast.

---

# 3. Carry Armed Entry

The branch now also contains a bounded, explicitly authorized conditional-entry layer.

This feature answers a practical problem discovered during the research phase:

> A useful carry opportunity may appear only after the funding trajectory, basis, liquidity, fee-adjusted cushion, and settlement timing line up. The user should not have to keep a browser open and manually watch every tick.

Armed Entry therefore lets the user configure **one concrete carry opportunity**, approve its future entry, and let the backend wait for the configured conditions.

It does **not** scan the market and choose trades autonomously.

## Armed Entry inputs

The user still chooses the trading intent, including:

- asset
- short venue
- long venue
- total target quantity
- per-order quantity
- entry basis threshold
- left / right leverage
- minimum funding edge
- minimum carry cushion
- minimum open interest
- minimum time remaining before funding settlement

The first Armed Entry implementation uses **Taker–Taker** execution. The ordinary Position page still retains its existing manual Maker–Taker option; Armed Entry does not remove or alter it.

The reason for using Taker–Taker for the first unattended entry mode is to avoid a resting maker order surviving while the carry conditions that justified the entry have already changed.

## Carry Gate

Before an Armed Entry may trigger, the backend evaluates the current opportunity using live and locally persisted data.

The gate includes, among other checks:

- backend Live Trading must still be enabled;
- the credential profile that armed the trade must still be the active account;
- both live markets must be fresh CrossEx WebSocket data;
- executable basis must meet the Position entry threshold;
- funding observations must be sufficiently fresh and numerous;
- normalized funding edge must meet the configured minimum;
- the short funding trajectory must not be in an unacceptable decay state;
- current account execution fees must be available;
- fee-adjusted carry cushion must meet the configured minimum;
- open interest must meet the configured minimum on both legs when required;
- the trade must not be too close to the next funding settlement when a minimum lead time is configured.

Missing or stale required information is treated as a failed gate rather than silently ignored.

## Reuse of the existing execution engine

Passing the Carry Gate does not directly place two raw orders from the Armed service.

The service crosses the application's existing strategy-launch boundary, so the triggered position still uses the same infrastructure as a manually launched finite paired Position strategy, including:

- instrument discovery and constraints
- minimum size / lot / notional checks
- leverage and position-tier checks
- margin preflight
- live-trading lock
- credential mutation gate
- paired-leg submission
- partial-fill handling
- residual hedge repair
- reduce-risk repair paths
- persistent execution logs
- shutdown / quiesce handling

This avoids maintaining a second, less-audited execution implementation specifically for carry.

---

# 4. Armed Entry state machine and safety behavior

The persistent state machine is:

```text
ARMED
  -> TRIGGERING
  -> TRIGGERED
  -> COMPLETED
```

Additional terminal / intervention states:

```text
CANCELLED
ERROR
```

## `ARMED`

The user has explicitly authorized a future entry, but no execution strategy has started.

The backend continues evaluating the Carry Gate even when the browser is closed, as long as the backend process itself is running.

## `TRIGGERING`

The Carry Gate has passed and the service has atomically claimed this Armed Entry before requesting an execution strategy.

A crash during this narrow state is handled fail-closed: on restart, an interrupted trigger is marked for manual review instead of automatically attempting another entry that could duplicate exposure.

## `TRIGGERED`

An existing finite Position execution strategy has been created and is still establishing the authorized target position.

Importantly, the Carry Gate continues to be monitored while the target position is incomplete.

### If the Carry Gate disappears before any fill

```text
TRIGGERED execution strategy
  -> stop strategy
  -> no position opened
  -> Armed Entry returns to ARMED
  -> wait for the next valid opportunity
```

### If the Carry Gate disappears after partial exposure exists

```text
TRIGGERED execution strategy
  -> stop further accumulation
  -> preserve / repair the already-created hedge using existing execution safety logic
  -> do not silently start a new entry cycle
  -> mark Armed Entry ERROR / manual review required
```

The system deliberately does not invent a new automated exit rule for this case. Partial live exposure is a materially different risk state and should not be converted into an unreviewed carry lifecycle.

## `COMPLETED`

The finite Position strategy finished building the authorized target position.

The historical Armed record remains visible, but it no longer blocks the same pair from being armed again later.

## `CANCELLED`

An untriggered Armed Entry can be cancelled by the user.

A user may also stop an already-triggered execution through the Armed control while it is still building the position. Once actual exposure exists, the system does not pretend this is equivalent to cancelling an untouched watch; the resulting state requires the appropriate execution / position review.

---

# 5. Persistence

A second migration adds:

```text
carry_armed_entries
```

This table stores:

- Armed Entry ID
- status
- asset
- short / long CrossEx symbols
- bound credential profile and label
- finite Position strategy configuration
- Carry Gate configuration
- last gate reason
- last gate metrics
- linked triggered Strategy ID
- error reason
- create / update / trigger / cancel timestamps

This persistence is what allows the browser to close without losing a waiting Armed Entry.

---

# 6. What changed in this branch

Relative to `main`, the branch currently changes 25 files. The changes are grouped below by responsibility.

## Backend: funding research

### `apps/backend/src/funding-observations.ts`

Adds `FundingObservationStore`, responsible for persisting real-time funding formation with bounded sampling and boot-seed protection.

### `apps/backend/src/funding-observations.test.ts`

Adds tests for the observation store. These tests were added but have not been run during this online-editing phase.

### `apps/backend/src/carry-analytics.ts`

Adds pure analytics for:

- funding trajectory summaries
- local peak / drawdown
- 1h / 4h slopes
- `RISING` / `DECAYING` / `FLAT` / `INSUFFICIENT`
- basis mean / standard deviation / z-score
- executable basis

### `apps/backend/src/carry-analytics.test.ts`

Adds analytics tests; not run during this phase.

### `apps/backend/src/carry-research-routes.ts`

Adds the read-only funding-observation API.

### `apps/backend/src/carry-research-routes.test.ts`

Adds route tests for read-intent, valid local data, and invalid symbols; not run during this phase.

## Backend: Armed Entry

### `apps/backend/src/carry-entry-gate.ts`

Adds the pure Carry Gate evaluator used by the unattended entry layer.

It combines funding trajectory, funding edge, executable basis, fees, carry cushion, observation freshness, open interest, and settlement timing into a fail-closed entry decision.

### `apps/backend/src/carry-entry-gate.test.ts`

Adds Carry Gate tests covering important pass/fail conditions. The file was written but has not been executed during this online-editing phase.

### `apps/backend/src/carry-armed-service.ts`

Adds the persistent Armed Entry state machine and backend evaluator.

Responsibilities include:

- create / list / cancel Armed Entries
- evaluate ARMED entries
- atomically claim a passing opportunity
- launch the existing finite paired strategy path
- monitor the Carry Gate while a triggered strategy is still accumulating
- re-arm a zero-fill invalidated entry
- stop further accumulation and require review when a partially filled carry loses its gate
- fail closed after interrupted trigger recovery

### `apps/backend/src/carry-armed-routes.ts`

Adds HTTP routes used by the frontend to create, list, and cancel Armed Entries.

### `apps/backend/src/server.ts`

Wires both the funding-observation research routes and Carry Armed Entry service into the production backend process.

The Armed service starts only after the backend has successfully begun listening and is stopped before application shutdown/quiescence.

## Backend: database lifecycle

### `migrations/0021_funding_rate_observations.sql`

Creates the real-time funding observation table and indexes.

### `migrations/0022_carry_armed_entries.sql`

Creates the persistent Armed Entry table and indexes.

### `apps/backend/src/database.ts`

Adds the new Carry tables to current-schema integrity checks.

### `apps/backend/src/database-maintenance.ts`

Adds retention management for high-frequency funding observation rows.

## Frontend: research

### `apps/frontend/src/carry-research-api.ts`

Adds the read-only funding observation client and response validation.

### `apps/frontend/src/carry-research.ts`

Adds pure frontend research calculations for basis statistics, fees, carry cushion, and break-even metrics.

### `apps/frontend/src/carry-research.test.ts`

Adds frontend calculation / parser tests; not run during this phase.

### `apps/frontend/src/carry-research-panel.tsx`

Adds the Carry Research Panel containing funding formation, basis, fees, break-even, and the Armed Entry control area.

### `apps/frontend/src/carry-research.css`

Adds Carry research and Armed Entry presentation styles.

## Frontend: Armed Entry

### `apps/frontend/src/carry-armed-api.ts`

Adds the browser API client and types for the Armed Entry lifecycle.

### `apps/frontend/src/carry-armed-controls.tsx`

Adds the explicit live-trading authorization UI used to configure and ARM one selected carry opportunity, display current backend state / gate reason, and cancel or stop it where allowed.

## Existing frontend integration

### `apps/frontend/src/strategy-route.tsx`

Extends the paired Position view with:

- funding overview data
- realized funding history
- Carry Research Panel
- Historical Basis in Position mode
- executable basis and fee inputs needed by Carry research

The existing manual finite Position execution and existing Auto price-difference behavior remain separate.

### `apps/frontend/src/main.tsx`

Loads the Carry research stylesheet.

## Documentation

### `docs/carry-research.md`

Documents the research layer, Armed Entry behavior, safety state machine, implementation inventory, phase boundary, and local validation plan.

---

# 7. What this phase deliberately does not do

The meaning of “this phase is complete” is important.

It does **not** mean that the project now contains a complete autonomous carry trading system.

This phase deliberately does not implement:

- an autonomous market-wide carry opportunity selector that decides what to trade without a user choosing the pair;
- a new `carry` Strategy Engine kind with its own full entry / holding / exit lifecycle;
- automatic rebalancing or rolling from one carry pair to another;
- a model that predicts future funding as a core trigger dependency;
- a carry-specific automatic exit policy when funding collapses after the full position has already been established;
- dynamic capital allocation across multiple simultaneous carry opportunities;
- portfolio-level ranking by expected net PnL / risk;
- automatic stop-loss, basis-risk liquidation, or regime-switch logic specific to carry;
- automated learning from realized carry trade outcomes;
- mark/index divergence as a required carry trigger feed.

The current Armed Entry is intentionally narrower:

```text
Human identifies opportunity
  -> human configures exact trade and risk limits
  -> human explicitly ARM-s it
  -> backend waits for those exact conditions
  -> existing finite paired executor builds that one position
```

That is a **human-authorized conditional execution layer**, not a self-directed carry strategy.

---

# 8. What the next “Carry automatic strategy” phase would mean

A true next phase begins when the system itself must answer questions such as:

```text
Which asset should I trade?
Which venue pair is best?
How much capital should I allocate?
Is the funding persistence strong enough to expect future carry?
How much adverse basis movement can I tolerate?
When should I stop adding?
When should I exit an already-open carry?
Should I roll into another venue pair?
How do I compare two opportunities with different funding intervals, fees, OI, basis volatility and liquidation risk?
```

That requires a different design layer:

- opportunity ranking / portfolio allocation
- carry-specific strategy lifecycle
- entry and exit regime rules
- persistent expected-value / realized-PnL attribution
- basis-risk and funding-decay risk model
- position holding and settlement accounting
- automatic unwind / rebalance rules
- portfolio-wide limits

The present phase intentionally stops before that boundary.

Its deliverable is the infrastructure required to make that later design evidence-based rather than speculative.

---

# 9. Local validation checklist

The branch was prepared through online GitHub editing. The assistant did **not intentionally run** the application, build, lint, typecheck, unit tests, or E2E tests. Do not treat the presence of test files as evidence that they pass.

Before using live capital, validate locally on a disposable database / very small account exposure first.

## Funding research

1. apply migration `0021_funding_rate_observations.sql`;
2. confirm the observation table remains empty until real public funding data replaces boot placeholders;
3. keep two active markets subscribed for several minutes and inspect 30-second sampling plus immediate rate-change sampling;
4. call `/api/markets/funding-observations` and verify timestamps, peak, slopes, and state;
5. open Funding → paired Position and verify realized funding, live funding formation, Carry Research, and Historical Basis;
6. switch direction and verify short / long funding, executable basis, and funding edge all reverse consistently;
7. compare displayed fees with the account's current CrossEx fee settings;
8. verify the 90-day observation retention logic on disposable data.

## Armed Entry

9. apply migration `0022_carry_armed_entries.sql`;
10. confirm an Armed Entry persists after the browser page is closed / reopened;
11. verify missing or stale funding observations prevent triggering;
12. verify low funding edge prevents triggering;
13. verify `DECAYING` short funding prevents triggering when configured by the gate;
14. verify insufficient open interest prevents triggering when an OI minimum is configured;
15. verify insufficient time before settlement prevents triggering;
16. verify unavailable account fee data prevents triggering rather than being treated as zero cost;
17. verify the active account must match the credential profile that originally armed the trade;
18. verify switching Live Trading to readonly prevents an Armed Entry from triggering;
19. verify a passing gate starts the normal finite paired Position strategy rather than a separate raw-order path;
20. verify the triggered strategy still performs all normal instrument, lot, notional, margin, leverage, and position-tier checks;
21. create a zero-fill trigger, invalidate the Carry Gate, and verify the strategy stops and the Armed Entry returns to `ARMED`;
22. create a deliberately tiny partial-fill scenario, invalidate the Carry Gate, and verify further accumulation stops and the Armed record requires manual review rather than silently opening a new cycle;
23. complete the authorized target position and verify the Armed record transitions to `COMPLETED`;
24. verify a historical `COMPLETED` record does not prevent the same pair from being armed again later;
25. verify Cancel works on an untouched `ARMED` record;
26. simulate / inspect restart behavior for a persisted `TRIGGERING` row and confirm it fails closed for manual review instead of automatically retrying;
27. inspect Strategy Engine logs for triggered Carry entries and verify execution still uses the existing paired execution / hedge-repair paths.

## Static / automated checks

28. run backend and frontend typecheck;
29. run the newly added carry / funding unit tests;
30. run the existing Strategy Engine and trading-runtime regression tests;
31. run the normal application build;
32. perform a minimal live-capital test only after the local and automated checks above pass.
