import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type StrategyConfig, type TradingMode, type VenueFeeRate } from './api.js';
import { numericFutureFeeRate } from './fee-rates.js';
import {
  armCarryEntry,
  cancelCarryArmedEntry,
  listCarryArmedEntries,
  type CarryArmedEntry,
} from './carry-armed-api.js';

interface CarryArmedControlsProps {
  language: 'en' | 'zh';
  asset: string;
  shortSymbol: string;
  longSymbol: string;
  shortFundingIntervalHours: number | null;
  longFundingIntervalHours: number | null;
}

function finiteText(value: string): number | null {
  if (!/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveText(value: string): boolean {
  const parsed = finiteText(value);
  return parsed !== null && parsed > 0;
}

function venueFromSymbol(symbol: string): string {
  return (symbol.split('_')[0] ?? '').toLowerCase();
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
    passed: ['全部条件通过，正在进入实盘执行边界', 'All conditions passed; entering live execution boundary'],
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
  const [entryBps, setEntryBps] = useState('0');
  const [perOrderQuantity, setPerOrderQuantity] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [shortLeverage, setShortLeverage] = useState('1');
  const [longLeverage, setLongLeverage] = useState('1');
  const [minFundingEdge, setMinFundingEdge] = useState('8');
  const [minCushion, setMinCushion] = useState('4');
  const [minOiMillions, setMinOiMillions] = useState('5');
  const [minSecondsToFunding, setMinSecondsToFunding] = useState('120');
  const [entries, setEntries] = useState<CarryArmedEntry[]>([]);
  const [fees, setFees] = useState<VenueFeeRate[]>([]);
  const [tradingMode, setTradingMode] = useState<TradingMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const [armed, mode] = await Promise.all([
        listCarryArmedEntries(signal),
        api.tradingMode(),
      ]);
      setEntries(armed);
      setTradingMode(mode.mode);
    } catch {
      if (!signal?.aborted) setNotice(zh ? '无法读取 Armed 状态' : 'Unable to read Armed status');
    }
  }, [zh]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    void api.fees().then((response) => setFees(response.fees)).catch(() => undefined);
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
  const shortVenue = venueFromSymbol(props.shortSymbol);
  const longVenue = venueFromSymbol(props.longSymbol);
  const shortTakerFee = numericFutureFeeRate(fees, shortVenue, props.shortSymbol, 'taker') ?? null;
  const longTakerFee = numericFutureFeeRate(fees, longVenue, props.longSymbol, 'taker') ?? null;

  const entry = finiteText(entryBps);
  const edge = finiteText(minFundingEdge);
  const cushion = finiteText(minCushion);
  const oiMillions = finiteText(minOiMillions);
  const secondsToFunding = finiteText(minSecondsToFunding);
  const leverageValid = positiveText(shortLeverage) && Number(shortLeverage) <= 200
    && positiveText(longLeverage) && Number(longLeverage) <= 200;
  const sizeValid = positiveText(perOrderQuantity) && positiveText(totalAmount)
    && Number(perOrderQuantity) <= Number(totalAmount);
  const prerequisitesReady = props.shortFundingIntervalHours !== null && props.shortFundingIntervalHours > 0
    && props.longFundingIntervalHours !== null && props.longFundingIntervalHours > 0
    && shortTakerFee !== null && Number.isFinite(shortTakerFee)
    && longTakerFee !== null && Number.isFinite(longTakerFee);
  const thresholdsValid = entry !== null
    && edge !== null && edge >= 0
    && cushion !== null
    && oiMillions !== null && oiMillions >= 0
    && secondsToFunding !== null && secondsToFunding >= 0 && Number.isInteger(secondsToFunding);
  const armEnabled = tradingMode === 'live' && prerequisitesReady && thresholdsValid && leverageValid && sizeValid && !active && !busy;

  const strategy = useMemo<StrategyConfig | null>(() => {
    if (!sizeValid || !leverageValid || entry === null) return null;
    return {
      kind: 'position',
      asset: props.asset,
      leftVenue: shortVenue.toUpperCase(),
      rightVenue: longVenue.toUpperCase(),
      leftSide: 'SELL',
      rightSide: 'BUY',
      entryBps,
      perOrderQuantity,
      totalAmount,
      leftLeverage: shortLeverage,
      rightLeverage: longLeverage,
      reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
      hedgeMode: 'SHARE_RATIO',
      grid: false,
    };
  }, [entry, entryBps, leverageValid, longLeverage, longVenue, perOrderQuantity, props.asset, shortLeverage, shortVenue, sizeValid, totalAmount]);

  const arm = async () => {
    if (!armEnabled || !strategy || edge === null || cushion === null || oiMillions === null || secondsToFunding === null
      || props.shortFundingIntervalHours === null || props.longFundingIntervalHours === null
      || shortTakerFee === null || longTakerFee === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const created = await armCarryEntry({
        strategy,
        shortSymbol: props.shortSymbol,
        longSymbol: props.longSymbol,
        gate: {
          enabled: true,
          minFundingEdgeBps: edge,
          minCarryCushionBps: cushion,
          shortFundingIntervalHours: props.shortFundingIntervalHours,
          longFundingIntervalHours: props.longFundingIntervalHours,
          shortExecutionFeeRate: shortTakerFee,
          longExecutionFeeRate: longTakerFee,
          observationLookbackHours: 4,
          minObservationCount: 3,
          maxObservationAgeSeconds: 180,
          requireShortNotDecaying: true,
          requireLongNotRising: false,
          minOpenInterestUsdPerLeg: oiMillions * 1_000_000,
          minSecondsToFunding: secondsToFunding,
        },
      });
      setEntries((current) => [created, ...current.filter((item) => item.id !== created.id)]);
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
      setEntries((current) => current.map((entryItem) => entryItem.id === updated.id ? updated : entryItem));
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
      <div><span className="carry-armed-dot" /><div><strong>Carry Armed Entry</strong><small>{zh ? '后台持续等待；全部条件通过后进入现有两腿实盘执行引擎' : 'Backend waits continuously; all gates must pass before the existing two-leg live engine is invoked'}</small></div></div>
      <em className={`carry-armed-status status-${(recent?.status ?? 'idle').toLowerCase()}`}>{recent?.status ?? 'IDLE'}</em>
    </header>

    <div className="carry-armed-section-title"><strong>{zh ? '实盘授权参数' : 'Live authorization parameters'}</strong><small>{zh ? 'Armed 第一版固定使用 Taker–Taker；手动 Position 的 Maker–Taker 功能不受影响。' : 'Armed v1 uses Taker–Taker only; manual Position Maker–Taker remains unchanged.'}</small></div>
    <div className="carry-armed-fields carry-armed-execution-fields">
      <label><span>{zh ? '总开仓量' : 'Total amount'}</span><div><input inputMode="decimal" value={totalAmount} onChange={(event) => setTotalAmount(event.target.value)} disabled={Boolean(active)} /><b>{props.asset}</b></div></label>
      <label><span>{zh ? '每次开仓量' : 'Per-order amount'}</span><div><input inputMode="decimal" value={perOrderQuantity} onChange={(event) => setPerOrderQuantity(event.target.value)} disabled={Boolean(active)} /><b>{props.asset}</b></div></label>
      <label><span>{zh ? '最小可执行 Basis' : 'Min executable basis'}</span><div><input inputMode="decimal" value={entryBps} onChange={(event) => setEntryBps(event.target.value)} disabled={Boolean(active)} /><b>bps</b></div></label>
      <label><span>{zh ? '空头 / 多头杠杆' : 'Short / long leverage'}</span><div className="carry-dual-input"><input inputMode="decimal" value={shortLeverage} onChange={(event) => setShortLeverage(event.target.value)} disabled={Boolean(active)} /><i>/</i><input inputMode="decimal" value={longLeverage} onChange={(event) => setLongLeverage(event.target.value)} disabled={Boolean(active)} /><b>×</b></div></label>
    </div>

    <div className="carry-armed-section-title"><strong>{zh ? 'Carry Gate' : 'Carry gate'}</strong><small>{zh ? '所有条件同时满足才授权开仓' : 'Every condition must pass at the same time'}</small></div>
    <div className="carry-armed-fields">
      <label><span>{zh ? '最小 Funding Edge / 8h' : 'Min funding edge / 8h'}</span><div><input inputMode="decimal" value={minFundingEdge} onChange={(event) => setMinFundingEdge(event.target.value)} disabled={Boolean(active)} /><b>bps</b></div></label>
      <label><span>{zh ? '最小 Carry Cushion' : 'Min carry cushion'}</span><div><input inputMode="decimal" value={minCushion} onChange={(event) => setMinCushion(event.target.value)} disabled={Boolean(active)} /><b>bps</b></div></label>
      <label><span>{zh ? '每腿最小 OI' : 'Min OI per leg'}</span><div><input inputMode="decimal" value={minOiMillions} onChange={(event) => setMinOiMillions(event.target.value)} disabled={Boolean(active)} /><b>$M</b></div></label>
      <label><span>{zh ? '距结算至少' : 'Min time to funding'}</span><div><input inputMode="numeric" value={minSecondsToFunding} onChange={(event) => setMinSecondsToFunding(event.target.value)} disabled={Boolean(active)} /><b>sec</b></div></label>
    </div>

    <div className="carry-armed-rules">
      <span>✓ Basis ≥ {entryBps || '—'} bps</span>
      <span>✓ {zh ? '空头 Funding 不得处于 DECAYING' : 'Short funding must not be DECAYING'}</span>
      <span>✓ {zh ? 'Funding 观测 ≤ 180s，使用 4h 轨迹' : 'Funding observations ≤ 180s; 4h trajectory'}</span>
      <span>✓ {zh ? '往返手续费按当前账户 Taker 费率快照计入' : 'Round-trip fees use the current account taker-fee snapshot'}</span>
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

    {!prerequisitesReady && <p className="carry-armed-warning">{zh ? 'Funding interval 或当前账户 Taker 手续费尚未加载，禁止 Armed。' : 'Funding interval or current account taker fees are not loaded; arming is blocked.'}</p>}
    {tradingMode !== 'live' && <p className="carry-armed-warning">{zh ? 'Live Trading 当前未启用。先在顶部切换到 Live，才能创建未来实盘授权。' : 'Live Trading is not enabled. Switch to Live before creating future execution authorization.'}</p>}
    <div className="carry-armed-actions">
      {active
        ? <button type="button" className="carry-cancel-button" onClick={() => void cancel()} disabled={busy || active.status === 'TRIGGERING'}>{busy ? (zh ? '处理中…' : 'Working…') : zh ? '取消 Armed' : 'Cancel armed entry'}</button>
        : <button type="button" className="carry-arm-button" onClick={() => void arm()} disabled={!armEnabled}>{busy ? (zh ? '提交中…' : 'Arming…') : zh ? 'ARM · 后台等待并自动开仓' : 'ARM · wait and enter automatically'}</button>}
      <small>{zh ? 'ARM 是持久化的未来实盘授权，不是提醒。网页可以关闭；Backend 必须持续运行。锁定 Live Trading、切换账户或数据失效时不会触发。' : 'ARM is persistent future live-trading authorization, not an alert. The browser may close; the backend must stay running. Locked Live Trading, account mismatch, or stale data blocks execution.'}</small>
    </div>
    {notice && <p className="carry-armed-notice">{notice}</p>}
  </section>;
}
