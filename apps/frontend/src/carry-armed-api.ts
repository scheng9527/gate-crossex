import type { StrategyConfig } from './api.js';

export type CarryArmedStatus = 'ARMED' | 'TRIGGERING' | 'TRIGGERED' | 'COMPLETED' | 'CANCELLED' | 'ERROR';

export interface CarryArmedGateConfig {
  enabled: true;
  minFundingEdgeBps: number;
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

export interface CarryArmedMetrics {
  fundingEdgeBps8h: number | null;
  executableBasisBps: number;
  roundTripFeeBps: number | null;
  carryCushionBps8hProxy: number | null;
  shortFundingState: 'RISING' | 'DECAYING' | 'FLAT' | 'INSUFFICIENT';
  longFundingState: 'RISING' | 'DECAYING' | 'FLAT' | 'INSUFFICIENT';
  shortObservationCount: number;
  longObservationCount: number;
  shortObservationAgeSeconds: number | null;
  longObservationAgeSeconds: number | null;
  shortOpenInterestUsd: number | null;
  longOpenInterestUsd: number | null;
  shortSecondsToFunding: number | null;
  longSecondsToFunding: number | null;
}

export interface CarryArmedEntry {
  id: string;
  status: CarryArmedStatus;
  asset: string;
  shortSymbol: string;
  longSymbol: string;
  credentialProfileId: string;
  credentialProfileLabel: string;
  strategy: StrategyConfig;
  gate: CarryArmedGateConfig;
  lastGateReason: string | null;
  lastGateMetrics: CarryArmedMetrics | null;
  triggeredStrategyId: string | null;
  errorReason: string | null;
  createdAt: string;
  updatedAt: string;
  triggeredAt: string | null;
  cancelledAt: string | null;
}

export class CarryArmedApiError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code.replaceAll('_', ' '));
  }
}

function isEntry(value: unknown): value is CarryArmedEntry {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === 'string'
    && /^CARRY-[A-Z0-9]{10}$/.test(item.id)
    && ['ARMED', 'TRIGGERING', 'TRIGGERED', 'COMPLETED', 'CANCELLED', 'ERROR'].includes(String(item.status))
    && typeof item.asset === 'string'
    && typeof item.shortSymbol === 'string'
    && typeof item.longSymbol === 'string'
    && typeof item.credentialProfileId === 'string'
    && typeof item.credentialProfileLabel === 'string'
    && Boolean(item.strategy && typeof item.strategy === 'object')
    && Boolean(item.gate && typeof item.gate === 'object');
}

async function payload(response: Response): Promise<unknown> {
  return response.json().catch(() => ({ error: 'invalid_backend_response' }));
}

function failureCode(value: unknown): string {
  if (!value || typeof value !== 'object') return 'request_failed';
  const error = (value as Record<string, unknown>).error;
  return typeof error === 'string' ? error : 'request_failed';
}

export async function listCarryArmedEntries(signal?: AbortSignal): Promise<CarryArmedEntry[]> {
  const response = await fetch('/api/carry/armed', {
    headers: { Accept: 'application/json', 'x-gct-read-intent': 'carry-armed' },
    signal,
  });
  const raw = await payload(response);
  if (!response.ok) throw new CarryArmedApiError(failureCode(raw), response.status);
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries)) {
    throw new CarryArmedApiError('invalid_backend_response', response.status);
  }
  const entries = (raw as { entries: unknown[] }).entries;
  if (!entries.every(isEntry)) throw new CarryArmedApiError('invalid_backend_response', response.status);
  return entries;
}

export async function armCarryEntry(input: {
  strategy: StrategyConfig;
  gate: CarryArmedGateConfig;
  shortSymbol: string;
  longSymbol: string;
}): Promise<CarryArmedEntry> {
  const response = await fetch('/api/carry/armed', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-gct-trading-intent': 'arm-carry-entry',
    },
    body: JSON.stringify(input),
  });
  const raw = await payload(response);
  if (!response.ok) throw new CarryArmedApiError(failureCode(raw), response.status);
  if (!isEntry(raw)) throw new CarryArmedApiError('invalid_backend_response', response.status);
  return raw;
}

export async function cancelCarryArmedEntry(id: string): Promise<CarryArmedEntry> {
  const response = await fetch(`/api/carry/armed/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'x-gct-trading-intent': 'cancel-carry-entry' },
  });
  const raw = await payload(response);
  if (!response.ok) throw new CarryArmedApiError(failureCode(raw), response.status);
  if (!isEntry(raw)) throw new CarryArmedApiError('invalid_backend_response', response.status);
  return raw;
}
