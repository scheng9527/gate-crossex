export interface BasisResearchSummary {
  currentBps: number | null;
  meanBps: number | null;
  stdDevBps: number | null;
  zScore: number | null;
  sampleCount: number;
}

export interface CarryEconomics {
  fundingEdgeBps: number | null;
  executableBasisBps: number | null;
  roundTripFeeBps: number | null;
  oneIntervalCushionBps: number | null;
  fundingOnlyBreakEvenIntervals: number | null;
  fundingOnlyBreakEvenHours: number | null;
  basisAdjustedBreakEvenIntervals: number | null;
  basisAdjustedBreakEvenHours: number | null;
}

function finite(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

export function summarizeBasisResearch(currentBps: number | null, historyBps: readonly number[]): BasisResearchSummary {
  const values = historyBps.filter(Number.isFinite);
  if (values.length === 0) return { currentBps, meanBps: null, stdDevBps: null, zScore: null, sampleCount: 0 };
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);
  return {
    currentBps,
    meanBps: mean,
    stdDevBps: stdDev,
    zScore: currentBps === null || stdDev === 0 ? null : (currentBps - mean) / stdDev,
    sampleCount: values.length,
  };
}

/**
 * Carry economics for one short/long pair.
 * `fundingEdgePercent8h` is percentage points (0.10 means 0.10%), while fee rates are native
 * fractions (0.0005 means 5 bps). Positive executable basis means the short can currently be sold
 * above the long's executable ask.
 */
export function buildCarryEconomics(input: {
  fundingEdgePercent8h: number | null;
  executableBasisBps: number | null;
  shortExecutionFeeRate: number | null;
  longExecutionFeeRate: number | null;
}): CarryEconomics {
  const fundingEdgePercent8h = finite(input.fundingEdgePercent8h);
  const basis = finite(input.executableBasisBps);
  const shortFee = finite(input.shortExecutionFeeRate);
  const longFee = finite(input.longExecutionFeeRate);
  const fundingEdgeBps = fundingEdgePercent8h === null ? null : fundingEdgePercent8h * 100;
  const roundTripFeeBps = shortFee === null || longFee === null ? null : (shortFee + longFee) * 2 * 10_000;
  const oneIntervalCushionBps = fundingEdgeBps === null || basis === null || roundTripFeeBps === null
    ? null
    : fundingEdgeBps + basis - roundTripFeeBps;

  const fundingOnlyBreakEvenIntervals = fundingEdgeBps !== null && fundingEdgeBps > 0 && roundTripFeeBps !== null
    ? roundTripFeeBps / fundingEdgeBps
    : null;
  const basisAdjustedBreakEvenIntervals = fundingEdgeBps !== null && fundingEdgeBps > 0 && roundTripFeeBps !== null && basis !== null
    ? Math.max(0, roundTripFeeBps - basis) / fundingEdgeBps
    : null;

  return {
    fundingEdgeBps,
    executableBasisBps: basis,
    roundTripFeeBps,
    oneIntervalCushionBps,
    fundingOnlyBreakEvenIntervals,
    fundingOnlyBreakEvenHours: fundingOnlyBreakEvenIntervals === null ? null : fundingOnlyBreakEvenIntervals * 8,
    basisAdjustedBreakEvenIntervals,
    basisAdjustedBreakEvenHours: basisAdjustedBreakEvenIntervals === null ? null : basisAdjustedBreakEvenIntervals * 8,
  };
}
