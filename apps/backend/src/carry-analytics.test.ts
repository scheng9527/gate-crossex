import { describe, expect, it } from 'vitest';
import {
  buildCarryResearchSnapshot,
  executableBasisBps,
  summarizeBasis,
  summarizeFundingTrajectory,
} from './carry-analytics.js';
import type { FundingObservation } from './funding-observations.js';

function observation(hoursAgo: number, rate: number, now: number): FundingObservation {
  return {
    symbol: 'BINANCE_FUTURE_BTC_USDT',
    observedAt: new Date(now - hoursAgo * 60 * 60_000).toISOString(),
    fundingRate: String(rate),
    nextFundingAt: new Date(now + 8 * 60 * 60_000).toISOString(),
    source: 'gate_crossex_websocket',
  };
}

describe('carry analytics', () => {
  it('calculates executable short-bid versus long-ask basis', () => {
    expect(executableBasisBps(101, 100)).toBeCloseTo(100, 10);
    expect(executableBasisBps(0, 100)).toBeNull();
  });

  it('summarizes funding peak, drawdown and decay', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z');
    const summary = summarizeFundingTrajectory([
      observation(4, 0.0004, now),
      observation(2, 0.0015, now),
      observation(1, 0.0012, now),
      observation(0, 0.0009, now),
    ], now);
    expect(summary.currentRate).toBe(0.0009);
    expect(summary.localPeakRate).toBe(0.0015);
    expect(summary.localPeakAt).toBe(new Date(now - 2 * 60 * 60_000).toISOString());
    expect(summary.drawdownFromPeakPct).toBeCloseTo(-40, 8);
    expect(summary.oneHourSlopeBps).toBeCloseTo(-3, 8);
    expect(summary.state).toBe('DECAYING');
  });

  it('calculates basis distribution and z-score', () => {
    const summary = summarizeBasis(20, [0, 10, 20, 30]);
    expect(summary.meanBps).toBe(15);
    expect(summary.stdDevBps).toBeCloseTo(Math.sqrt(125), 10);
    expect(summary.zScore).toBeCloseTo(5 / Math.sqrt(125), 10);
  });

  it('combines funding edge, executable basis and round-trip taker fees', () => {
    const snapshot = buildCarryResearchSnapshot({
      shortFundingRate: 0.001,
      longFundingRate: 0.0002,
      shortBid: 101,
      longAsk: 100,
      shortTakerFeeRate: 0.0005,
      longTakerFeeRate: 0.0004,
    });
    expect(snapshot.fundingEdgeBps).toBeCloseTo(8, 10);
    expect(snapshot.executableBasisBps).toBeCloseTo(100, 10);
    expect(snapshot.roundTripFeeBps).toBeCloseTo(18, 10);
    expect(snapshot.oneIntervalCushionBps).toBeCloseTo(90, 10);
  });
});
