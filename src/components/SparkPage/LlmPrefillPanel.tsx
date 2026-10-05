import { useEffect, useState } from "react";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay, LlmMetrics } from "../../api/types";
import {
  CostEstimateDialog,
  DEFAULT_LLM_PRICES,
  fmtYuan,
  loadLlmPrices,
  type LlmPrices,
} from "./CostEstimateDialog";

const CHART_W = 196;
const CHART_H = 36;
const POLL_MS = 60_000;

function fmtTok(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return n.toFixed(0);
}

function fmtTokLong(n: number): string {
  return n.toLocaleString();
}

function DailyPrefillChart({
  days,
  prices,
}: {
  days: LlmDailyDay[];
  prices: LlmPrices;
}) {
  if (!days || days.length === 0) return null;

  const hasSplit = days.some((d) => d.uncachedPrefillTokens != null);
  const decodeVals = days.map((d) => d.decodeTokens || 0);
  const prefVals = days.map((d) => d.prefillTokens || 0);
  const max = Math.max(1, ...decodeVals, ...prefVals);
  const n = days.length;
  const gap = 1.5;
  const slot = CHART_W / n;
  const barW = Math.max(1.5, (slot - gap) / 2);

  const busy = days.some(
    (d) => (d.decodeTokens || 0) > 0 || (d.prefillTokens || 0) > 0
  );

  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted">
          Daily tokens
        </span>
        <span className="text-[10px] text-muted">
          {hasSplit ? "decode · prefill (cached/uncached)" : "decode · prefill"} · 14d
        </span>
      </div>
      {!busy ? (
        <p className="text-[10px] text-muted">No token activity in the last 14 days.</p>
      ) : (
        <>
        <svg
          width={CHART_W}
          height={CHART_H}
          className="block max-w-full"
          role="img"
          aria-label="Daily decode and prefill tokens"
        >
          {days.map((d, i) => {
            const x0 = i * slot;
            const decH = ((d.decodeTokens || 0) / max) * (CHART_H - 2);
            const pref = d.prefillTokens || 0;
            const prefH = (pref / max) * (CHART_H - 2);
            const cached = hasSplit ? d.cachedPrefillTokens || 0 : 0;
            const uncached = hasSplit ? d.uncachedPrefillTokens || 0 : pref;
            const cachedH = (cached / max) * (CHART_H - 2);
            const uncH = (uncached / max) * (CHART_H - 2);
            const dayCost =
              ((d.decodeTokens || 0) / 1e6) * (prices.output || 0) +
              (uncached / 1e6) * (prices.uncached || 0) +
              (cached / 1e6) * (prices.cached || 0);
            const title = [
              d.date,
              `decode ${fmtTok(d.decodeTokens)}`,
              hasSplit
                ? `prefill ${fmtTok(uncached)} uncached · ${fmtTok(cached)} cached`
                : `prefill ${fmtTok(d.prefillTokens)}`,
              `cost ${fmtYuan(dayCost)}`,
            ].join(" · ");
            return (
              <g key={d.date}>
                <title>{title}</title>
                <rect
                  x={x0}
                  y={CHART_H - decH}
                  width={barW}
                  height={decH}
                  fill="var(--color-accent)"
                  opacity={0.9}
                />
                {hasSplit ? (
                  <>
                    <rect
                      x={x0 + barW + 0.5}
                      y={CHART_H - cachedH}
                      width={barW}
                      height={cachedH}
                      fill="var(--color-muted)"
                      opacity={0.35}
                    />
                    <rect
                      x={x0 + barW + 0.5}
                      y={CHART_H - cachedH - uncH}
                      width={barW}
                      height={uncH}
                      fill="var(--color-text)"
                      opacity={0.55}
                    />
                  </>
                ) : (
                  <rect
                    x={x0 + barW + 0.5}
                    y={CHART_H - prefH}
                    width={barW}
                    height={prefH}
                    fill="var(--color-text)"
                    opacity={0.45}
                  />
                )}
              </g>
            );
          })}
        </svg>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted">
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2"
              style={{ background: "var(--color-accent)", opacity: 0.9 }}
            />
            decode
          </span>
          {hasSplit ? (
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2"
                style={{ background: "var(--color-text)", opacity: 0.55 }}
              />
              prefill uncached
              <span
                className="inline-block h-2 w-2"
                style={{ background: "var(--color-muted)", opacity: 0.35 }}
              />
              cached
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2"
                style={{ background: "var(--color-text)", opacity: 0.45 }}
              />
              prefill
            </span>
          )}
        </div>
        </>
      )}
    </div>
  );
}

interface LlmPrefillPanelProps {
  llm: LlmMetrics | null;
  sparkId: string;
  llmPort: number;
}

export function LlmPrefillPanel({ llm, sparkId, llmPort }: LlmPrefillPanelProps) {
  const [days, setDays] = useState<LlmDailyDay[] | null>(null);
  const [prices, setPrices] = useState<LlmPrices>(loadLlmPrices);
  const [costOpen, setCostOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLlmDaily(sparkId, llmPort, 14)
        .then((res) => {
          if (!cancelled) setDays(res.days || []);
        })
        .catch(() => {
          if (!cancelled) setDays([]);
        });
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [sparkId, llmPort]);

  if (!llm) return null;

  const totalPrefill = llm.totalPrefillTokens || 0;
  const hasSplit =
    llm.totalCachedPrefillTokens != null && llm.totalUncachedPrefillTokens != null;
  const cached = hasSplit ? llm.totalCachedPrefillTokens || 0 : null;
  const uncached = llm.totalUncachedPrefillTokens ?? null;

  const uncEff = hasSplit ? llm.totalUncachedPrefillTokens || 0 : totalPrefill;
  const cacheEff = hasSplit ? llm.totalCachedPrefillTokens || 0 : 0;
  const cost =
    (uncEff / 1e6) * (prices.uncached ?? DEFAULT_LLM_PRICES.uncached) +
    (cacheEff / 1e6) * (prices.cached ?? DEFAULT_LLM_PRICES.cached) +
    ((llm.totalOutputTokens || 0) / 1e6) *
      (prices.output ?? DEFAULT_LLM_PRICES.output);

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Total Prefill
          </div>
          <div className="font-tabular text-sm text-text">
            {totalPrefill > 0 ? fmtTokLong(totalPrefill) : "—"}
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Prefill Cached
          </div>
          <div className="font-tabular text-sm text-muted">
            {cached != null && cached > 0 ? fmtTokLong(cached) : "—"}
          </div>
        </div>
        <div className="space-y-0.5">
          <div className="text-[10px] uppercase tracking-wide text-muted">
            Prefill Uncached
          </div>
          <div className="font-tabular text-sm text-text">
            {uncached != null && uncached > 0 ? fmtTokLong(uncached) : "—"}
          </div>
        </div>
      </div>

      {days && days.length > 0 && <DailyPrefillChart days={days} prices={prices} />}

      <button
        type="button"
        onClick={() => setCostOpen(true)}
        className="group flex w-full items-center justify-between rounded-xl border border-border bg-surface-elevated px-4 py-3 text-left transition-colors hover:border-accent hover:bg-accent-soft"
        title="Open token usage details and estimated cost"
      >
        <span>
          <span className="block text-xs font-semibold text-text">Cost estimate</span>
          <span className="mt-0.5 block text-[10px] text-muted">View usage by date and token type</span>
        </span>
        <span className="flex items-center gap-2">
          <span className="font-tabular text-lg font-semibold text-accent">{fmtYuan(cost)}</span>
          <span className="text-muted transition-transform group-hover:translate-x-0.5">›</span>
        </span>
      </button>

      <CostEstimateDialog
        open={costOpen}
        onClose={() => setCostOpen(false)}
        llm={llm}
        sparkId={sparkId}
        llmPort={llmPort}
        prices={prices}
        onPricesChange={setPrices}
      />
    </div>
  );
}
