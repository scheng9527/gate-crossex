import type { FundingObservation } from './funding-observations.js';

export type FundingState = 'RISING' | 'DECAYING' | 'FLAT' | 'INSUFFICIENT';

export interface FundingTrajectorySummary {
  currentRate: number | null;
  oneHourAgoRate: number | null;
  fourHoursAgoRate: number | null;
  localPeakRate: number | null;
  localPeakAt: string | null;
  drawdownFromPeakPct: number | null;
  oneHourSlopeBps: number | null;
  fourHourSlopeBps: number | null;
  state: FundingState;
  observationCount: number;
}

export interface BasisSummary {
  currentBps: number | null;
  meanBps: number | null;
  stdDevBps: number | null;
  zScore: number | null;
  sampleCount: number;
}

export interface CarryResearchSnapshot {
  fundingEdgeBps: number | null;
  executableBasisBps: number | null;
  roundTripFeeBps: number | null;
  oneIntervalCushionBps: number | null;
}

function finiteNumber(value: string | number | null | undefined): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function nearestRateAtOrBefore(observations: FundingObservation[], timestampMs: number): number | null {
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (!observation) continue;
    const observedAt = Date.parse(observation.observedAt);
    if (!Number.isFinite(observedAt) || observedAt > timestampMs) continue;
    const rate = finiteNumber(observation.fundingRate);
    if (rate !== null) return rate;
  }
  return null;
}

export function summarizeFundingTrajectory(
  observations: FundingObservation[],
  nowMs = Date.now(),
): FundingTrajectorySummary {
  const valid = observations
    .map((observation) => ({
      observation,
      observedAtMs: Date.parse(observation.observedAt),
      rate: finiteNumber(observation.fundingRate),
    }))
    .filter((entry): entry is { observation: FundingObservation; observedAtMs: number; rate: number } =>
      Number.isFinite(entry.observedAtMs) && entry.rate !== null)
    .sort((left, right) => left.observedAtMs - right.observedAtMs);

  if (valid.length === 0) {
    return {
      currentRate: null,
      oneHourAgoRate: null,
      fourHoursAgoRate: null,
      localPeakRate: null,
      localPeakAt: null,
      drawdownFromPeakPct: null,
      oneHourSlopeBps: null,
      fourHourSlopeBps: null,
      state: 'INSUFFICIENT',
      observationCount: 0,
    };
  }

  const current = valid[valid.length - 1];
  if (!current) throw new Error('Funding trajectory unexpectedly empty');
  const sortedObservations = valid.map((entry) => entry.observation);
  const oneHourAgoRate = nearestRateAtOrBefore(sortedObservations, nowMs - 60 * 60_000);
  const fourHoursAgoRate = nearestRateAtOrBefore(sortedObservations, nowMs - 4 * 60 * 60_000);
  const peak = valid.reduce((best, entry) => entry.rate > best.rate ? entry : best, valid[0]!);
  const drawdownFromPeakPct = peak.rate === 0 ? null : ((current.rate - peak.rate) / Math.abs(peak.rate)) * 100;
  const oneHourSlopeBps = oneHourAgoRate === null ? null : (current.rate - oneHourAgoRate) * 10_000;
  const fourHourSlopeBps = fourHoursAgoRate === null ? null : (current.rate - fourHoursAgoRate) * 10_000;
  const slopeForState = oneHourSlopeBps ?? fourHourSlopeBps;
  const state: FundingState = slopeForState === null
    ? 'INSUFFICIENT'
    : slopeForState > 0.05
      ? 'RISING'
      : slopeForState < -0.05
        ? 'DECAYING'
        : 'FLAT';

  return {
    currentRate: current.rate,
    oneHourAgoRate,
    fourHoursAgoRate,
    localPeakRate: peak.rate,
    localPeakAt: peak.observation.observedAt,
    drawdownFromPeakPct,
    oneHourSlopeBps,
    fourHourSlopeBps,
    state,
    observationCount: valid.length,
  };
}

export function summarizeBasis(currentBps: number | null, historyBps: number[]): BasisSummary {
  const values = historyBps.filter(Number.isFinite);
  if (values.length === 0) {
    return { currentBps, meanBps: null, stdDevBps: null, zScore: null, sampleCount: 0 };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const zScore = currentBps === null || stdDev === 0 ? null : (currentBps - mean) / stdDev;
  return { currentBps, meanBps: mean, stdDevBps: stdDev, zScore, sampleCount: values.length };
}

export function executableBasisBps(shortBid: string | number, longAsk: string | number): number | null {
  const bid = finiteNumber(shortBid);
  const ask = finiteNumber(longAsk);
  if (bid === null || ask === null || bid <= 0 || ask <= 0) return null;
  return ((bid - ask) / ask) * 10_000;
}

export function buildCarryResearchSnapshot(input: {
  shortFundingRate: string | number;
  longFundingRate: string | number;
  shortBid: string | number;
  longAsk: string | number;
  shortTakerFeeRate?: string | number | null;
  longTakerFeeRate?: string | number | null;
}): CarryResearchSnapshot {
  const shortFunding = finiteNumber(input.shortFundingRate);
  const longFunding = finiteNumber(input.longFundingRate);
  const fundingEdgeBps = shortFunding === null || longFunding === null
    ? null
    : (shortFunding - longFunding) * 10_000;
  const basisBps = executableBasisBps(input.shortBid, input.longAsk);
  const shortFee = finiteNumber(input.shortTakerFeeRate);
  const longFee = finiteNumber(input.longTakerFeeRate);
  const roundTripFeeBps = shortFee === null || longFee === null
    ? null
    : (shortFee + longFee) * 2 * 10_000;
  const oneIntervalCushionBps = fundingEdgeBps === null || basisBps === null || roundTripFeeBps === null
    ? null
    : fundingEdgeBps + basisBps - roundTripFeeBps;

  return {
    fundingEdgeBps,
    executableBasisBps: basisBps,
    roundTripFeeBps,
    oneIntervalCushionBps,
  };
}
