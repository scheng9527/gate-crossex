import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { FundingChartSeries } from './charts.js';
import { CarryArmedControls } from './carry-armed-controls.js';
import { buildCarryEconomics, summarizeBasisResearch } from './carry-research.js';
import {
  loadFundingObservations,
  type FundingObservationEntry,
  type FundingTrajectoryState,
} from './carry-research-api.js';

const FundingHistoryChart = lazy(() => import('./charts.js').then((module) => ({ default: module.FundingHistoryChart })));

const OBSERVATION_RANGES = [4, 8, 24, 72] as const;
type ObservationHours = typeof OBSERVATION_RANGES[number];

interface CarryResearchPanelProps {
  language: 'en' | 'zh';
  theme: 'dark' | 'light';
  asset: string;
  shortVenueName: string;
  longVenueName: string;
  shortSymbol: string;
  longSymbol: string;
  shortFundingIntervalHours: number | null;
  longFundingIntervalHours: number | null;
  fundingEdgePercent8h: number | null;
  executableBasisBps: number | null;
  basisHistoryBps: readonly number[];
  shortExecutionFeeRate: number | null;
  longExecutionFeeRate: number | null;
}

function normalizeRatePercent8h(rateFraction: number, intervalHours: number | null): number | null {
  if (!Number.isFinite(rateFraction) || intervalHours === null || !Number.isFinite(intervalHours) || intervalHours <= 0) return null;
  return rateFraction * 100 * (8 / intervalHours);
}

function signed(value: number, digits: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
}

function stateText(language: 'en' | 'zh', state: FundingTrajectoryState): string {
  if (language === 'zh') {
    return state === 'RISING' ? '上升'
      : state === 'DECAYING' ? '衰减'
        : state === 'FLAT' ? '平稳'
          : '样本不足';
  }
  return state === 'RISING' ? 'Rising'
    : state === 'DECAYING' ? 'Decaying'
      : state === 'FLAT' ? 'Flat'
        : 'Insufficient';
}

function trajectoryMetric(
  entry: FundingObservationEntry | undefined,
  intervalHours: number | null,
): { current: number | null; peak: number | null; drawdown: number | null; slope: number | null; count: number; state: FundingTrajectoryState } {
  const summary = entry?.summary;
  return {
    current: summary?.currentRate === null || summary?.currentRate === undefined
      ? null : normalizeRatePercent8h(summary.currentRate, intervalHours),
    peak: summary?.localPeakRate === null || summary?.localPeakRate === undefined
      ? null : normalizeRatePercent8h(summary.localPeakRate, intervalHours),
    drawdown: summary?.drawdownFromPeakPct ?? null,
    slope: summary?.oneHourSlopeBps === null || summary?.oneHourSlopeBps === undefined || intervalHours === null || intervalHours <= 0
      ? null : summary.oneHourSlopeBps * (8 / intervalHours),
    count: summary?.observationCount ?? 0,
    state: summary?.state ?? 'INSUFFICIENT',
  };
}

export function CarryResearchPanel(props: CarryResearchPanelProps) {
  const [hours, setHours] = useState<ObservationHours>(24);
  const [entries, setEntries] = useState<Record<string, FundingObservationEntry>>({});
  const [status, setStatus] = useState<'loading' | 'ready' | 'empty' | 'error'>('loading');
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const zh = props.language === 'zh';

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = () => {
      controller?.abort();
      controller = new AbortController();
      setStatus((current) => current === 'ready' ? current : 'loading');
      void loadFundingObservations([props.shortSymbol, props.longSymbol], hours, controller.signal)
        .then((response) => {
          if (cancelled) return;
          const bySymbol = Object.fromEntries(response.entries.map((entry) => [entry.symbol, entry]));
          setEntries(bySymbol);
          setFetchedAt(response.fetchedAt);
          setStatus(response.entries.some((entry) => entry.points.length > 0) ? 'ready' : 'empty');
        })
        .catch(() => {
          if (cancelled || controller?.signal.aborted) return;
          setStatus('error');
        });
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
    };
  }, [hours, props.longSymbol, props.shortSymbol]);

  const shortEntry = entries[props.shortSymbol];
  const longEntry = entries[props.longSymbol];
  const shortTrajectory = trajectoryMetric(shortEntry, props.shortFundingIntervalHours);
  const longTrajectory = trajectoryMetric(longEntry, props.longFundingIntervalHours);
  const basis = useMemo(
    () => summarizeBasisResearch(props.executableBasisBps, props.basisHistoryBps),
    [props.basisHistoryBps, props.executableBasisBps],
  );
  const economics = useMemo(() => buildCarryEconomics({
    fundingEdgePercent8h: props.fundingEdgePercent8h,
    executableBasisBps: props.executableBasisBps,
    shortExecutionFeeRate: props.shortExecutionFeeRate,
    longExecutionFeeRate: props.longExecutionFeeRate,
  }), [props.executableBasisBps, props.fundingEdgePercent8h, props.longExecutionFeeRate, props.shortExecutionFeeRate]);

  const chartSeries = useMemo<FundingChartSeries[]>(() => {
    const makeSeries = (
      entry: FundingObservationEntry | undefined,
      intervalHours: number | null,
      id: string,
      label: string,
      color: string,
    ): FundingChartSeries[] => {
      if (!entry || intervalHours === null) return [];
      const points = entry.points.flatMap((point) => {
        const raw = Number(point.rate);
        const normalized = normalizeRatePercent8h(raw, intervalHours);
        return normalized === null ? [] : [{ time: point.timestamp, value: normalized }];
      });
      return points.length === 0 ? [] : [{ id, label, color, points }];
    };
    return [
      ...makeSeries(shortEntry, props.shortFundingIntervalHours, `${props.shortSymbol}:formation`, `${props.shortVenueName} · ${zh ? '空头' : 'Short'}`, '#e5a34d'),
      ...makeSeries(longEntry, props.longFundingIntervalHours, `${props.longSymbol}:formation`, `${props.longVenueName} · ${zh ? '多头' : 'Long'}`, '#4fb9a8'),
    ];
  }, [longEntry, props.longFundingIntervalHours, props.longSymbol, props.longVenueName, props.shortFundingIntervalHours, props.shortSymbol, props.shortVenueName, shortEntry, zh]);

  const formatBps = (value: number | null, digits = 2) => value === null ? '—' : `${signed(value, digits)} bps`;
  const formatPercent = (value: number | null, digits = 4) => value === null ? '—' : `${signed(value, digits)}%`;
  const formatHours = (value: number | null) => value === null ? '—' : value < 1 ? `${Math.round(value * 60)} min` : `${value.toFixed(value < 10 ? 1 : 0)} h`;

  return <article className="carry-research-panel terminal-panel">
    <header className="carry-research-head">
      <div>
        <p className="eyebrow">{zh ? 'Carry 研究' : 'Carry research'}</p>
        <h2>{props.asset} · {zh ? 'Funding 形成过程 + Basis + 成本' : 'Funding formation + basis + costs'}</h2>
        <small>{zh ? '上半部分为只读研究；下方 Armed Entry 必须单独授权' : 'Research above is read-only; Armed Entry below requires separate explicit authorization'}</small>
      </div>
      <div className="carry-range-control" role="group" aria-label={zh ? '观察窗口' : 'Observation window'}>
        {OBSERVATION_RANGES.map((value) => <button key={value} className={hours === value ? 'active' : ''} onClick={() => setHours(value)}>{value}H</button>)}
      </div>
    </header>

    <div className="carry-research-economics">
      <div><span>{zh ? 'Funding Edge / 8h' : 'Funding edge / 8h'}</span><strong>{formatBps(economics.fundingEdgeBps)}</strong><small>{props.shortVenueName} short − {props.longVenueName} long</small></div>
      <div><span>{zh ? '可执行 Basis' : 'Executable basis'}</span><strong>{formatBps(economics.executableBasisBps)}</strong><small>short bid − long ask</small></div>
      <div><span>{zh ? 'Basis Z-score' : 'Basis z-score'}</span><strong>{basis.zScore === null ? '—' : signed(basis.zScore, 2)}</strong><small>{basis.sampleCount} {zh ? '个历史样本' : 'historical samples'}</small></div>
      <div><span>{zh ? 'Basis 均值 / 波动' : 'Basis mean / σ'}</span><strong>{basis.meanBps === null ? '—' : `${basis.meanBps.toFixed(2)} / ${basis.stdDevBps?.toFixed(2) ?? '—'}`}</strong><small>bps</small></div>
      <div><span>{zh ? '往返手续费' : 'Round-trip fees'}</span><strong>{formatBps(economics.roundTripFeeBps)}</strong><small>{zh ? '按当前执行方式两腿进出' : 'both legs, entry + exit'}</small></div>
      <div><span>{zh ? '单周期 Carry Cushion' : 'One-interval carry cushion'}</span><strong className={economics.oneIntervalCushionBps !== null && economics.oneIntervalCushionBps < 0 ? 'negative' : undefined}>{formatBps(economics.oneIntervalCushionBps)}</strong><small>funding + entry basis − fees</small></div>
      <div><span>{zh ? '仅 Funding 回本' : 'Funding-only break-even'}</span><strong>{formatHours(economics.fundingOnlyBreakEvenHours)}</strong><small>{economics.fundingOnlyBreakEvenIntervals === null ? '—' : `${economics.fundingOnlyBreakEvenIntervals.toFixed(2)} × 8h`}</small></div>
      <div><span>{zh ? '计入入场 Basis 后回本' : 'Basis-adjusted break-even'}</span><strong>{formatHours(economics.basisAdjustedBreakEvenHours)}</strong><small>{zh ? '假设退出 Basis 回归 0' : 'assumes exit basis = 0'}</small></div>
    </div>

    <div className="carry-trajectory-grid">
      {[
        { name: props.shortVenueName, side: zh ? '空头腿' : 'Short leg', metric: shortTrajectory },
        { name: props.longVenueName, side: zh ? '多头腿' : 'Long leg', metric: longTrajectory },
      ].map(({ name, side, metric }) => <section key={name} className={`carry-trajectory-card state-${metric.state.toLowerCase()}`}>
        <header><div><strong>{name}</strong><small>{side}</small></div><em>{stateText(props.language, metric.state)}</em></header>
        <dl>
          <div><dt>{zh ? '当前 / 8h' : 'Current / 8h'}</dt><dd>{formatPercent(metric.current)}</dd></div>
          <div><dt>{zh ? '局部峰值 / 8h' : 'Local peak / 8h'}</dt><dd>{formatPercent(metric.peak)}</dd></div>
          <div><dt>{zh ? '距峰值回撤' : 'Drawdown from peak'}</dt><dd>{metric.drawdown === null ? '—' : `${metric.drawdown.toFixed(1)}%`}</dd></div>
          <div><dt>{zh ? '1h 斜率 / 8h' : '1h slope / 8h'}</dt><dd>{formatBps(metric.slope)}</dd></div>
        </dl>
        <footer>{metric.count} {zh ? '个实时观测点' : 'live observations'}</footer>
      </section>)}
    </div>

    <div className="carry-formation-chart">
      <div className="carry-formation-title"><strong>{zh ? 'Funding 实时形成轨迹（8h 等价）' : 'Live funding formation (8h equivalent)'}</strong><small>{fetchedAt ? new Date(fetchedAt).toLocaleString(zh ? 'zh-CN' : 'en-GB') : status === 'loading' ? (zh ? '加载中…' : 'Loading…') : '—'}</small></div>
      <Suspense fallback={<div className="carry-research-placeholder">{zh ? '正在加载轨迹…' : 'Loading trajectory…'}</div>}>
        <FundingHistoryChart
          series={chartSeries}
          seriesKey={`${props.shortSymbol}:${props.longSymbol}:${hours}`}
          theme={props.theme}
          locale={zh ? 'zh-CN' : 'en-US'}
          placeholder={status === 'error'
            ? (zh ? 'Funding 观测数据不可用。' : 'Funding observations unavailable.')
            : status === 'empty'
              ? (zh ? '正在积累实时 Funding 样本；首次真实 funding 推送后开始记录。' : 'Collecting live funding samples; recording begins after the first real funding push.')
              : (zh ? '正在加载 Funding 形成轨迹…' : 'Loading funding formation…')}
          showDataTable={false}
        />
      </Suspense>
    </div>

    <footer className="carry-research-note">
      <span>ⓘ</span>
      <p>{zh
        ? '可执行 Basis 优先使用当前 short bid / long ask；历史 Basis 使用已存在的 Kline 收盘价差作为分布参考。若实时 WS 报价暂不可用，Position 页面可能回退到最近参考价，因此交易前仍应确认实时盘口。Z-score 是研究信号，不是成交保证。'
        : 'Executable basis prefers the current short bid / long ask. Historical basis uses the existing candle-close spread as a distribution proxy. If the live WS quote is temporarily unavailable, the Position screen may fall back to its latest reference price, so confirm the live book before trading. The z-score is a research signal, not a fill guarantee.'}</p>
    </footer>

    <CarryArmedControls
      language={props.language}
      asset={props.asset}
      shortSymbol={props.shortSymbol}
      longSymbol={props.longSymbol}
      shortFundingIntervalHours={props.shortFundingIntervalHours}
      longFundingIntervalHours={props.longFundingIntervalHours}
    />
  </article>;
}
