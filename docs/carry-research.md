# Carry research layer

This branch adds a read-only carry research layer on top of the public market data the application already receives. It intentionally does **not** add a new automated carry strategy or change the order-execution engine.

## Scope

The research workflow is:

```text
Funding scanner
  -> paired Position view (short high-funding venue / long low-funding venue)
  -> live funding formation + realized funding history
  -> executable entry basis + historical basis distribution
  -> fees + break-even + carry cushion
  -> manual review / existing finite paired execution
```

The existing native-venue funding-history fetchers and candle backfill remain unchanged.

## Funding observations

`CrossExMarketHub` already subscribes to the public `funding_rate` WebSocket channel. The new `FundingObservationStore` listens to the same market stream and persists the funding-rate formation process to SQLite.

Table: `funding_rate_observations`

Stored fields:

- CrossEx symbol
- backend observation time
- current funding rate
- next funding time
- source

Sampling is bounded:

- persist after at least 30 seconds since the previous sample; or
- persist immediately when the rate moves by at least 0.5 bp.

The hub starts with deterministic demo placeholders. The store is primed with those values before the socket starts and will not persist a symbol until a later funding value or next-funding timestamp proves that a real funding-channel update has arrived. This prevents boot placeholders from contaminating research history.

`LiveMarket.updatedAt` is deliberately not used as the funding observation timestamp because it represents ticker/executable-price freshness and does not advance on funding-only frames.

Funding observations are retained for 90 days by normal database maintenance.

## Read-only API

`POST /api/markets/funding-observations`

Header:

```text
x-gct-read-intent: funding-observations
```

Body:

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

- current rate
- approximately 1-hour-ago and 4-hour-ago rates
- local peak and peak time
- drawdown from the local peak
- 1-hour and 4-hour slopes
- state: `RISING`, `DECAYING`, `FLAT`, or `INSUFFICIENT`

## Carry Research Panel

The paired Position view now also loads price-difference candles, so the same existing `PriceDifferenceHistoryChart` can be used for Position research rather than only the continuous auto strategy.

The Carry Research Panel shows:

- short/long funding formation trajectories, normalized to an 8-hour equivalent
- current funding edge
- current entry basis
- historical basis mean and standard deviation
- basis z-score
- round-trip execution-fee estimate
- one-funding-interval carry cushion
- funding-only fee break-even time
- basis-adjusted fee break-even time

### Executable basis

For a short venue `S` and long venue `L`, the desired entry convention is:

```text
ExecutableBasisBps = (Bid_S - Ask_L) / Ask_L * 10000
```

The Position screen's live pair uses bid/ask when the CrossEx WebSocket quote is live. Historical basis, however, is derived from synchronized candle closes using the application's existing candle history. These are intentionally displayed as different concepts: the historical distribution is a research proxy and does not promise executable fills.

### Funding edge

After normalizing each venue to an 8-hour equivalent:

```text
FundingEdge = Funding_short - Funding_long
```

Positive values favor the intended short-high / long-low carry direction, before basis and fees.

### Fees and break-even

For the execution method selected on the Position screen, the panel uses the configured maker/taker fee for each leg. The simple round-trip estimate assumes the same execution role on entry and exit:

```text
RoundTripFeeBps = 2 * (Fee_short + Fee_long) * 10000
```

One-interval cushion is:

```text
FundingEdgeBps + ExecutableBasisBps - RoundTripFeeBps
```

The basis-adjusted break-even time assumes the entry basis ultimately exits at zero. It is a research scenario, not a forecast.

## Deliberate non-goals

This phase does not:

- introduce a `carry` Strategy Engine mode
- automatically open a trade because funding or basis crosses a threshold
- depend on predicted/indicative funding
- add mark/index feeds to the carry trigger
- replace realized funding history or native candle backfill

The purpose of this phase is to accumulate the missing funding-formation data and make the relationship between funding, basis, fees, and subsequent PnL observable before any carry-specific automation is considered.

## Local validation checklist

The branch was prepared without intentionally running the application, build, lint, typecheck, unit tests, or E2E tests. Before merge, validate locally:

1. apply migration `0021_funding_rate_observations.sql` to a disposable/local database;
2. start the backend and confirm the observation table remains empty until real public funding data replaces boot placeholders;
3. leave two active markets subscribed for several minutes and confirm sampling cadence and rate-change sampling;
4. call the observation endpoint for the two symbols and verify timestamps, peak, slopes, and state;
5. open Funding, choose a candidate, and open the paired Position view;
6. confirm Position shows realized funding, Carry Research, and Historical Basis for the selected venues;
7. verify switching direction swaps the short/long interpretation and changes executable basis/funding edge consistently;
8. compare displayed fee estimates against the current CrossEx fee settings;
9. verify observation retention/database maintenance on a disposable database;
10. only after local validation, restore normal CI behavior for the branch or open a PR so `pull_request` CI runs.
