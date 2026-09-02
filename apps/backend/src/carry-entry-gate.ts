import type Database from 'better-sqlite3';
import type { LiveMarket } from './market-hub.js';
import { summarizeFundingTrajectory, type FundingState } from './carry-analytics.js';
import type { FundingObservation } from './funding-observations.js';

export interface CarryEntryGateConfig {
  enabled: true;
  /** Minimum 8-hour-equivalent short-minus-long funding edge. */
  minFundingEdgeBps: number;
  /** Minimum funding + entry basis - round-trip fees, expressed as an 8h research proxy. */
  minCarryCushionBps: number;
  shortFundingIntervalHours: number;
  longFundingIntervalHours: number;
  shortExecutionFeeRate: number;
  longExecutionFeeRate: number;
  observationLookbackHours: number;
  minObservationCount: number;
  maxObservationAgeSeconds: number;
  requireShortNotDecaying: boolean;
  requireLongNotRising: boolean;
  minOpenInterestUsdPerLeg: number;
  minSecondsToFunding: number;
}

export type CarryEntryGateReason =
  | 'passed'
  | 'invalid_config'
  | 'invalid_funding_data'
  | 'funding_observation_missing'
  | 'funding_observation_stale'
  | 'funding_samples_insufficient'
  | 'funding_edge_below_minimum'
  | 'short_funding_decaying'
  | 'long_funding_rising'
  | 'carry_cushion_below_minimum'
  | 'open_interest_below_minimum'
  | 'funding_window_too_close';

export interface CarryEntryGateMetrics {
  fundingEdgeBps8h: number | null;
  executableBasisBps: number;
  roundTripFeeBps: number | null;
  carryCushionBps8hProxy: number | null;
  shortFundingState: FundingState;
  longFundingState: FundingState;
  shortObservationCount: number;
  longObservationCount: number;
  shortObservationAgeSeconds: number | null;
  longObservationAgeSeconds: number | null;
  shortOpenInterestUsd: number | null;
  longOpenInterestUsd: number | null;
  shortSecondsToFunding: number | null;
  longSecondsToFunding: number | null;
}

export interface CarryEntryGateDecision {
  passed: boolean;
  reason: CarryEntryGateReason;
  metrics: CarryEntryGateMetrics;
}

function finiteNumber(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readObservations(
  database: Database.Database,
  symbol: string,
  since: string,
): FundingObservation[] {
  const rows = database.prepare(`
    SELECT symbol, observed_at, funding_rate, next_funding_at, source
    FROM funding_rate_observations
    WHERE symbol = ? AND observed_at >= ?
    ORDER BY observed_at ASC
    LIMIT 5000
  `).all(symbol, since) as Array<{
    symbol: string;
    observed_at: string;
    funding_rate: string;
    next_funding_at: string;
    source: string;
  }>;
  return rows.map((row) => ({
    symbol: row.symbol,
    observedAt: row.observed_at,
    fundingRate: row.funding_rate,
    nextFundingAt: row.next_funding_at,
    source: row.source,
  }));
}

function latestObservationAgeSeconds(observations: FundingObservation[], nowMs: number): number | null {
  const latest = observations[observations.length - 1];
  if (!latest) return null;
  const at = Date.parse(latest.observedAt);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, (nowMs - at) / 1000);
}

function secondsToFunding(market: LiveMarket, nowMs: number): number | null {
  const at = Date.parse(market.nextFundingAt);
  return Number.isFinite(at) ? (at - nowMs) / 1000 : null;
}

function normalizedFundingBps8h(rate: string, intervalHours: number): number | null {
  const numeric = finiteNumber(rate);
  if (numeric === null || !Number.isFinite(intervalHours) || intervalHours <= 0) return null;
  return numeric * 10_000 * (8 / intervalHours);
}

function blankMetrics(executableBasisBps: number): CarryEntryGateMetrics {
  return {
    fundingEdgeBps8h: null,
    executableBasisBps,
    roundTripFeeBps: null,
    carryCushionBps8hProxy: null,
    shortFundingState: 'INSUFFICIENT',
    longFundingState: 'INSUFFICIENT',
    shortObservationCount: 0,
    longObservationCount: 0,
    shortObservationAgeSeconds: null,
    longObservationAgeSeconds: null,
    shortOpenInterestUsd: null,
    longOpenInterestUsd: null,
    shortSecondsToFunding: null,
    longSecondsToFunding: null,
  };
}

/**
 * Fail-closed pre-entry guard for a user-armed funding carry pair.
 *
 * This evaluator never submits/cancels orders. StrategyEngine calls it only before increasing
 * exposure. Hedge repair, exits, reduce-only actions and safety flattening deliberately bypass it.
 */
export function evaluateCarryEntryGate(input: {
  database: Database.Database;
  config: CarryEntryGateConfig;
  shortMarket: LiveMarket;
  longMarket: LiveMarket;
  executableBasisBps: number;
  nowMs?: number;
}): CarryEntryGateDecision {
  const { database, config, shortMarket, longMarket, executableBasisBps } = input;
  const nowMs = input.nowMs ?? Date.now();
  const metrics = blankMetrics(executableBasisBps);
  const finiteConfig = [
    config.minFundingEdgeBps,
    config.minCarryCushionBps,
    config.shortFundingIntervalHours,
    config.longFundingIntervalHours,
    config.shortExecutionFeeRate,
    config.longExecutionFeeRate,
    config.observationLookbackHours,
    config.minObservationCount,
    config.maxObservationAgeSeconds,
    config.minOpenInterestUsdPerLeg,
    config.minSecondsToFunding,
  ].every(Number.isFinite);
  if (!finiteConfig
    || config.shortFundingIntervalHours <= 0
    || config.longFundingIntervalHours <= 0
    || config.observationLookbackHours <= 0
    || config.minObservationCount < 1
    || config.maxObservationAgeSeconds <= 0
    || config.minOpenInterestUsdPerLeg < 0
    || config.minSecondsToFunding < 0) {
    return { passed: false, reason: 'invalid_config', metrics };
  }

  const shortFunding = normalizedFundingBps8h(shortMarket.fundingRate, config.shortFundingIntervalHours);
  const longFunding = normalizedFundingBps8h(longMarket.fundingRate, config.longFundingIntervalHours);
  if (shortFunding === null || longFunding === null) {
    return { passed: false, reason: 'invalid_funding_data', metrics };
  }
  metrics.fundingEdgeBps8h = shortFunding - longFunding;
  metrics.roundTripFeeBps = (config.shortExecutionFeeRate + config.longExecutionFeeRate) * 2 * 10_000;
  metrics.carryCushionBps8hProxy = metrics.fundingEdgeBps8h + executableBasisBps - metrics.roundTripFeeBps;

  const since = new Date(nowMs - config.observationLookbackHours * 60 * 60_000).toISOString();
  const shortObservations = readObservations(database, shortMarket.symbol, since);
  const longObservations = readObservations(database, longMarket.symbol, since);
  metrics.shortObservationCount = shortObservations.length;
  metrics.longObservationCount = longObservations.length;
  metrics.shortObservationAgeSeconds = latestObservationAgeSeconds(shortObservations, nowMs);
  metrics.longObservationAgeSeconds = latestObservationAgeSeconds(longObservations, nowMs);
  if (shortObservations.length === 0 || longObservations.length === 0) {
    return { passed: false, reason: 'funding_observation_missing', metrics };
  }
  if (metrics.shortObservationAgeSeconds === null || metrics.longObservationAgeSeconds === null
    || metrics.shortObservationAgeSeconds > config.maxObservationAgeSeconds
    || metrics.longObservationAgeSeconds > config.maxObservationAgeSeconds) {
    return { passed: false, reason: 'funding_observation_stale', metrics };
  }

  const shortTrajectory = summarizeFundingTrajectory(shortObservations, nowMs);
  const longTrajectory = summarizeFundingTrajectory(longObservations, nowMs);
  metrics.shortFundingState = shortTrajectory.state;
  metrics.longFundingState = longTrajectory.state;
  if (shortTrajectory.observationCount < config.minObservationCount
    || longTrajectory.observationCount < config.minObservationCount
    || shortTrajectory.state === 'INSUFFICIENT'
    || longTrajectory.state === 'INSUFFICIENT') {
    return { passed: false, reason: 'funding_samples_insufficient', metrics };
  }

  if (metrics.fundingEdgeBps8h < config.minFundingEdgeBps) {
    return { passed: false, reason: 'funding_edge_below_minimum', metrics };
  }
  if (config.requireShortNotDecaying && shortTrajectory.state === 'DECAYING') {
    return { passed: false, reason: 'short_funding_decaying', metrics };
  }
  if (config.requireLongNotRising && longTrajectory.state === 'RISING') {
    return { passed: false, reason: 'long_funding_rising', metrics };
  }
  if (metrics.carryCushionBps8hProxy < config.minCarryCushionBps) {
    return { passed: false, reason: 'carry_cushion_below_minimum', metrics };
  }

  metrics.shortOpenInterestUsd = finiteNumber(shortMarket.openInterestValue);
  metrics.longOpenInterestUsd = finiteNumber(longMarket.openInterestValue);
  if (config.minOpenInterestUsdPerLeg > 0 && (
    metrics.shortOpenInterestUsd === null || metrics.longOpenInterestUsd === null
    || metrics.shortOpenInterestUsd < config.minOpenInterestUsdPerLeg
    || metrics.longOpenInterestUsd < config.minOpenInterestUsdPerLeg
  )) {
    return { passed: false, reason: 'open_interest_below_minimum', metrics };
  }

  metrics.shortSecondsToFunding = secondsToFunding(shortMarket, nowMs);
  metrics.longSecondsToFunding = secondsToFunding(longMarket, nowMs);
  if (config.minSecondsToFunding > 0 && (
    metrics.shortSecondsToFunding === null || metrics.longSecondsToFunding === null
    || metrics.shortSecondsToFunding < config.minSecondsToFunding
    || metrics.longSecondsToFunding < config.minSecondsToFunding
  )) {
    return { passed: false, reason: 'funding_window_too_close', metrics };
  }

  return { passed: true, reason: 'passed', metrics };
}

export function carryGateDecisionText(decision: CarryEntryGateDecision): string {
  const metric = decision.metrics;
  const value = (input: number | null, digits = 2) => input === null ? '—' : input.toFixed(digits);
  return [
    `reason=${decision.reason}`,
    `fundingEdge8h=${value(metric.fundingEdgeBps8h)}bps`,
    `basis=${value(metric.executableBasisBps)}bps`,
    `fees=${value(metric.roundTripFeeBps)}bps`,
    `cushion8hProxy=${value(metric.carryCushionBps8hProxy)}bps`,
    `shortState=${metric.shortFundingState}`,
    `longState=${metric.longFundingState}`,
    `samples=${metric.shortObservationCount}/${metric.longObservationCount}`,
    `oi=${value(metric.shortOpenInterestUsd, 0)}/${value(metric.longOpenInterestUsd, 0)}`,
  ].join(' · ');
}
