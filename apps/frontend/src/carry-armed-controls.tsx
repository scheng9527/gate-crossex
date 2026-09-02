import { useCallback, useEffect, useMemo, useState } from 'react';
import type { StrategyConfig } from './api.js';
import {
  armCarryEntry,
  cancelCarryArmedEntry,
  listCarryArmedEntries,
  type CarryArmedEntry,
} from './carry-armed-api.js';

interface CarryArmedControlsProps {
  language: 'en' | 'zh';
  strategy: StrategyConfig | null;
  shortSymbol: string;
  longSymbol: string;
  shortFundingIntervalHours: number | null;
  longFundingIntervalHours: number | null;
  shortExecutionFeeRate: number | null;
  longExecutionFeeRate: number | null;
  canArm: boolean;
  tradingEnabled: boolean;
}

function finiteText(value: string): number | null {
  if (!/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function reasonText(reason: string | null, zh: boolean): string {
  if (!reason) return zh ? '等待首次检查' : 'Waiting for first check';
  const labels: Record<string, [string, string]> = {
    live_trading_locked: ['实盘模式已锁定', 'Live trading is locked'],
    account_not_active: ['绑定账户当前未激活', 'Bound account is not active'],
    market_data_unavailable_or_stale: ['行情不可用或已过期', 'Market data unavailable or stale'],
    basis_below_entry_threshold: ['Basis 尚未达到入场阈值', 'Basis below entry threshold'],
    invalid_funding_data: ['Funding 数据无效', 'Funding data invalid'],
    funding_observation_missing: ['等待 Funding 实时观测样本', 'Waiting for live funding observations'],
    funding_observation_stale: ['Funding 观测已过期', 'Funding observations are stale'],
    funding_samples_insufficient: ['Funding 轨迹样本不足', 'Funding trajectory samples insufficient'],
    funding_edge_below_minimum: ['Funding Edge 尚未达标', 'Funding edge below minimum'],
    short_funding_decaying: ['空头腿 Funding 正在衰减', 'Short-leg funding is decaying'],
    long_funding_rising: ['多头腿 Funding 正在上升', 'Long-leg funding is rising'],
    carry_cushion_below_minimum: ['扣费后 Carry Cushion 尚未达标', 'Carry cushion below minimum'],
    open_interest_below_minimum: ['单腿 OI 低于阈值', 'Open interest below minimum'],
    funding_window_too_close: ['距离 Funding 结算过近', 'Too close to funding settlement'],
    passed: ['全部条件通过，正在进入执行边界', 'All conditions passed; entering execution boundary'],
    carry_gate_internal_error: ['Carry Gate 内部检查失败', 'Carry gate internal check failed'],
  };
  if (reason.startsWith('start_retry:')) return zh ? `执行预检查暂未通过：${reason.slice(12)}` : `Execution preflight retry: ${reason.slice(12)}`;
  const item = labels[reason];
  return item ? item[zh ? 0 : 1] : reason.replaceAll('_', ' ');
}

function signedBps(value: number | null): string {
  return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(2)} bps`;
}

export function CarryArmedControls(props: CarryArmedControlsProps) {
  const zh = props.language === 'zh';
  const [minFundingEdge, setMinFundingEdge] = useState('8');
  const [minCushion, setMinCushion] = useState('4');
  const [minOiMillions, setMinOiMillions] = useState('5');
  const [minSecondsToFunding, setMinSecondsToFunding] = useState('120');
  const [entries, setEntries] = useState<CarryArmedEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const loaded = await listCarryArmedEntries(signal);
      setEntries(loaded);
    } catch {
      if (!signal?.aborted) setNotice(zh ? '无法读取 Armed 状态' : 'Unable to read Armed status');
    }
  }, [zh]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh]);

  const pairEntries = useMemo(() => entries.filter((entry) =>
    entry.shortSymbol === props.shortSymbol && entry.longSymbol === props.longSymbol),
  [entries, props.longSymbol, props.shortSymbol]);
  const active = pairEntries.find((entry) => entry.status === 'ARMED' || entry.status === 'TRIGGERING') ?? null;
  const recent = active ?? pairEntries[0] ?? null;

  const edge = finiteText(minFundingEdge);
  const cushion = finiteText(minCushion);
  const oiMillions = finiteText(minOiMillions);
  const secondsToFunding = finiteText(minSecondsToFunding);
  const prerequisitesReady = props.strategy !== null
    && props.shortFundingIntervalHours !== null && props.shortFundingIntervalHours > 0
    && props.longFundingIntervalHours !== null && props.longFundingIntervalHours > 0
    && props.shortExecutionFeeRate !== null && Number.isFinite(props.shortExecutionFeeRate)
    && props.longExecutionFeeRate !== null && Number.isFinite(props.longExecutionFeeRate);
  const thresholdsValid = edge !== null && edge >= 0
    && cushion !== null
    && oiMillions !== null && oiMillions >= 0
    && secondsToFunding !== null && secondsToFunding >= 0 && Number.isInteger(secondsToFunding);
  const armEnabled = props.canArm && props.tradingEnabled && prerequisitesReady && thresholdsValid && !active && !busy;

  const arm = async () => {
    if (!armEnabled || !props.strategy || edge === null || cushion === null || oiMillions === null || secondsToFunding === null
      || props.shortFundingIntervalHours === null || props.longFundingIntervalHours === null
      || props.shortExecutionFeeRate === null || props.longExecutionFeeRate === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await armCarryEntry({
        strategy: props.strategy,
        shortSymbol: props.shortSymbol,
        longSymbol: props.longSymbol,
        gate: {
          enabled: true,
          minFundingEdgeBps: edge,
          minCarryCushionBps: cushion,
          shortFundingIntervalHours: props.shortFundingIntervalHours,
          longFundingIntervalHours: props.longFundingIntervalHours,
          shortExecutionFeeRate: props.shortExecutionFeeRate,
          longExecutionFeeRate: props.longExecutionFeeRate,
          observationLookbackHours: 4,
          minObservationCount: 3,
          maxObservationAgeSeconds: 180,
          requireShortNotDecaying: true,
          requireLongNotRising: false,
          minOpenInterestUsdPerLeg: oiMillions * 1_000_000,
          minSecondsToFunding: secondsToFunding,
        },
      });
      setEntries((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
      setNotice(zh ? `已 Armed：${created.id}` : `Armed: ${created.id}`);
    } catch (error) {
      setNotice(zh ? `Armed 失败：${error instanceof Error ? error.message : 'unknown error'}` : `Arm failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!active || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      const updated = await cancelCarryArmedEntry(active.id);
      setEntries((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
      setNotice(zh ? '已取消 Armed Entry' : 'Armed entry cancelled');
    } catch (error) {
      setNotice(zh ? `取消失败：${error instanceof Error ? error.message : 'unknown error'}` : `Cancel failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    } finally {
      setBusy(false);
    }
  };

  const metrics = recent?.lastGateMetrics ?? null;
  return <section className="carry-armed-controls">
    <header>
      <div><span className="carry-armed-dot" /><div><strong>{zh ? 'Carry Armed Entry' : 'Carry Armed Entry'}</strong><small>{zh ? '后台 24h 等待；仅全部条件通过才进入原实盘执行引擎' : 'Backend waits 24/7; execution is authorized only after every gate passes'}</small></div></div>
      <em className={`carry-armed-status status-${(recent?.status ?? 'idle').toLowerCase()}`}>{recent?.status ?? 'IDLE'}</em>
    </header>

    <div className="carry-armed-fields">
      <label><span>{zh ? '最小 Funding Edge / 8h' : 'Min funding edge / 8h'}</span><div><input inputMode="decimal" value={minFundingEdge} onChange={(event) => setMinFundingEdge(event.target.value)} disabled={Boolean(active)} /><b>bps</b></div></label>
      <label><span>{zh ? '最小 Carry Cushion' : 'Min carry cushion'}</span><div><input inputMode="decimal" value={minCushion} onChange={(event) => setMinCushion(event.target.value)} disabled={Boolean(active)} /><b>bps</b></div></label>
      <label><span>{zh ? '每腿最小 OI' : 'Min OI per leg'}</span><div><input inputMode="decimal" value={minOiMillions} onChange={(event) => setMinOiMillions(event.target.value)} disabled={Boolean(active)} /><b>$M</b></div></label>
      <label><span>{zh ? '距结算至少' : 'Min time to funding'}</span><div><input inputMode="numeric" value={minSecondsToFunding} onChange={(event) => setMinSecondsToFunding(event.target.value)} disabled={Boolean(active)} /><b>sec</b></div></label>
    </div>

    <div className="carry-armed-rules">
      <span>✓ Basis ≥ {props.strategy?.entryBps ?? '—'} bps</span>
      <span>✓ {zh ? '空头 Funding 不得处于 DECAYING' : 'Short funding must not be DECAYING'}</span>
      <span>✓ {zh ? 'Funding 观测 ≤ 180s，使用 4h 轨迹' : 'Funding observations ≤ 180s; 4h trajectory'}</span>
      <span>✓ {zh ? '手续费按当前 Maker/Taker 配置快照计入' : 'Current maker/taker fee snapshot included'}</span>
    </div>

    {recent && <div className="carry-armed-live-state">
      <div><span>{zh ? '后台判断' : 'Backend decision'}</span><strong>{reasonText(recent.lastGateReason, zh)}</strong></div>
      <dl>
        <div><dt>Funding Edge</dt><dd>{signedBps(metrics?.fundingEdgeBps8h ?? null)}</dd></div>
        <div><dt>Basis</dt><dd>{signedBps(metrics?.executableBasisBps ?? null)}</dd></div>
        <div><dt>Cushion</dt><dd>{signedBps(metrics?.carryCushionBps8hProxy ?? null)}</dd></div>
        <div><dt>{zh ? 'Funding 状态' : 'Funding state'}</dt><dd>{metrics ? `${metrics.shortFundingState} / ${metrics.longFundingState}` : '—'}</dd></div>
      </dl>
      {recent.triggeredStrategyId && <small>{zh ? '已交给实盘策略' : 'Execution strategy'}: {recent.triggeredStrategyId}</small>}
      {recent.errorReason && <small className="negative">{recent.errorReason}</small>}
    </div>}

    {!prerequisitesReady && <p className="carry-armed-warning">{zh ? 'Funding interval 或当前执行手续费尚未加载，禁止 Armed。' : 'Funding interval or current execution fees are not loaded; arming is blocked.'}</p>}
    <div className="carry-armed-actions">
      {active
        ? <button type="button" className="carry-cancel-button" onClick={() => void cancel()} disabled={busy || active.status === 'TRIGGERING'}>{busy ? (zh ? '处理中…' : 'Working…') : zh ? '取消 Armed' : 'Cancel armed entry'}</button>
        : <button type="button" className="carry-arm-button" onClick={() => void arm()} disabled={!armEnabled}>{busy ? (zh ? '提交中…' : 'Arming…') : zh ? 'ARM · 后台等待并自动开仓' : 'ARM · wait and enter automatically'}</button>}
      <small>{zh ? 'ARM 是未来实盘授权，不是提醒。锁定 Live Trading、切换账户或数据失效时不会触发。' : 'ARM is future live-trading authorization, not an alert. Locked live mode, account mismatch, or stale data blocks execution.'}</small>
    </div>
    {notice && <p className="carry-armed-notice">{notice}</p>}
  </section>;
}
