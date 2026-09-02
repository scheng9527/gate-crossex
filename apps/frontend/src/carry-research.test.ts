import { describe, expect, it } from 'vitest';
import { buildCarryEconomics, summarizeBasisResearch } from './carry-research.js';
import { parseFundingObservationResponse } from './carry-research-api.js';

describe('carry research helpers', () => {
  it('summarizes the historical basis distribution around the executable value', () => {
    const summary = summarizeBasisResearch(25, [10, 20, 30, 40]);
    expect(summary.meanBps).toBe(25);
    expect(summary.stdDevBps).toBeCloseTo(Math.sqrt(125), 10);
    expect(summary.zScore).toBe(0);
    expect(summary.sampleCount).toBe(4);
  });

  it('keeps fee and funding units explicit in the carry economics', () => {
    const economics = buildCarryEconomics({
      fundingEdgePercent8h: 0.08,
      executableBasisBps: 12,
      shortExecutionFeeRate: 0.0005,
      longExecutionFeeRate: 0.0004,
    });
    expect(economics.fundingEdgeBps).toBeCloseTo(8, 10);
    expect(economics.roundTripFeeBps).toBeCloseTo(18, 10);
    expect(economics.oneIntervalCushionBps).toBeCloseTo(2, 10);
    expect(economics.fundingOnlyBreakEvenHours).toBeCloseTo(18, 10);
    expect(economics.basisAdjustedBreakEvenHours).toBeCloseTo(6, 10);
  });

  it('rejects malformed observation payloads instead of painting untrusted research data', () => {
    expect(parseFundingObservationResponse({ source: 'wrong', entries: [] })).toBeNull();
    expect(parseFundingObservationResponse({
      source: 'local_crossex_funding_observations',
      from: 1,
      to: 2,
      fetchedAt: '2026-09-02T00:00:00.000Z',
      entries: [{
        symbol: 'BINANCE_FUTURE_BTC_USDT',
        status: 'ok',
        points: [{ timestamp: 1, rate: '0.0001', nextFundingAt: '2026-09-02T08:00:00.000Z' }],
        summary: {
          currentRate: 0.0001,
          oneHourAgoRate: null,
          fourHoursAgoRate: null,
          localPeakRate: 0.0001,
          localPeakAt: '2026-09-02T00:00:00.000Z',
          drawdownFromPeakPct: 0,
          oneHourSlopeBps: null,
          fourHourSlopeBps: null,
          state: 'INSUFFICIENT',
          observationCount: 1,
        },
      }],
    })?.entries[0]?.summary.observationCount).toBe(1);
  });
});
