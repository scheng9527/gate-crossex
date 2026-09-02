export type FundingTrajectoryState = 'RISING' | 'DECAYING' | 'FLAT' | 'INSUFFICIENT';

export interface FundingTrajectorySummary {
  currentRate: number | null;
  oneHourAgoRate: number | null;
  fourHoursAgoRate: number | null;
  localPeakRate: number | null;
  localPeakAt: string | null;
  drawdownFromPeakPct: number | null;
  oneHourSlopeBps: number | null;
  fourHourSlopeBps: number | null;
  state: FundingTrajectoryState;
  observationCount: number;
}

export interface FundingObservationPoint {
  timestamp: number;
  rate: string;
  nextFundingAt: string;
}

export interface FundingObservationEntry {
  symbol: string;
  status: 'ok' | 'empty';
  points: FundingObservationPoint[];
  summary: FundingTrajectorySummary;
}

export interface FundingObservationResponse {
  entries: FundingObservationEntry[];
  from: number;
  to: number;
  fetchedAt: string;
  source: 'local_crossex_funding_observations';
}

function finiteOrNull(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function trajectorySummary(value: unknown): FundingTrajectorySummary | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const state = record.state;
  if (state !== 'RISING' && state !== 'DECAYING' && state !== 'FLAT' && state !== 'INSUFFICIENT') return null;
  const numbers = {
    currentRate: finiteOrNull(record.currentRate),
    oneHourAgoRate: finiteOrNull(record.oneHourAgoRate),
    fourHoursAgoRate: finiteOrNull(record.fourHoursAgoRate),
    localPeakRate: finiteOrNull(record.localPeakRate),
    drawdownFromPeakPct: finiteOrNull(record.drawdownFromPeakPct),
    oneHourSlopeBps: finiteOrNull(record.oneHourSlopeBps),
    fourHourSlopeBps: finiteOrNull(record.fourHourSlopeBps),
  };
  if (Object.values(numbers).some((item) => item === undefined)) return null;
  if (typeof record.observationCount !== 'number' || !Number.isInteger(record.observationCount) || record.observationCount < 0) return null;
  if (record.localPeakAt !== null && typeof record.localPeakAt !== 'string') return null;
  return {
    currentRate: numbers.currentRate ?? null,
    oneHourAgoRate: numbers.oneHourAgoRate ?? null,
    fourHoursAgoRate: numbers.fourHoursAgoRate ?? null,
    localPeakRate: numbers.localPeakRate ?? null,
    localPeakAt: record.localPeakAt as string | null,
    drawdownFromPeakPct: numbers.drawdownFromPeakPct ?? null,
    oneHourSlopeBps: numbers.oneHourSlopeBps ?? null,
    fourHourSlopeBps: numbers.fourHourSlopeBps ?? null,
    state,
    observationCount: record.observationCount,
  };
}

function parseFundingObservationResponse(value: unknown): FundingObservationResponse | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.source !== 'local_crossex_funding_observations'
    || typeof record.from !== 'number' || !Number.isFinite(record.from)
    || typeof record.to !== 'number' || !Number.isFinite(record.to)
    || typeof record.fetchedAt !== 'string'
    || !Array.isArray(record.entries)) return null;

  const entries: FundingObservationEntry[] = [];
  for (const candidate of record.entries) {
    if (!candidate || typeof candidate !== 'object') return null;
    const item = candidate as Record<string, unknown>;
    if (typeof item.symbol !== 'string' || (item.status !== 'ok' && item.status !== 'empty') || !Array.isArray(item.points)) return null;
    const summary = trajectorySummary(item.summary);
    if (!summary) return null;
    const points: FundingObservationPoint[] = [];
    for (const pointValue of item.points) {
      if (!pointValue || typeof pointValue !== 'object') return null;
      const point = pointValue as Record<string, unknown>;
      if (typeof point.timestamp !== 'number' || !Number.isFinite(point.timestamp)
        || typeof point.rate !== 'string' || typeof point.nextFundingAt !== 'string') return null;
      points.push({ timestamp: point.timestamp, rate: point.rate, nextFundingAt: point.nextFundingAt });
    }
    entries.push({ symbol: item.symbol, status: item.status, points, summary });
  }
  return { entries, from: record.from, to: record.to, fetchedAt: record.fetchedAt, source: record.source };
}

export async function loadFundingObservations(
  symbols: string[],
  durationHours: number,
  signal?: AbortSignal,
): Promise<FundingObservationResponse> {
  const timeout = AbortSignal.timeout(15_000);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch('/api/markets/funding-observations', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-gct-read-intent': 'funding-observations',
    },
    body: JSON.stringify({ symbols, durationHours }),
    signal: combinedSignal,
  });
  if (!response.ok) throw new Error(`funding_observations_${response.status}`);
  const parsed = parseFundingObservationResponse(await response.json());
  if (!parsed) throw new Error('invalid_funding_observation_response');
  return parsed;
}
