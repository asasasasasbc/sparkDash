import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { fetchLlmDaily } from "../../api/client";
import type { LlmDailyDay, LlmMetrics } from "../../api/types";
import { useModalPresence } from "../../hooks/useModalPresence";

export interface LlmPrices {
  cached: number;
  uncached: number;
  output: number;
}

export const DEFAULT_LLM_PRICES: LlmPrices = {
  cached: 0.1,
  uncached: 3.0,
  output: 9.0,
};

const PRICES_KEY = "sparkdash.llmPrices";
const POLL_MS = 60_000;

function toNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function loadLlmPrices(): LlmPrices {
  try {
    const raw = localStorage.getItem(PRICES_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        cached: toNum(p?.cached, DEFAULT_LLM_PRICES.cached),
        uncached: toNum(p?.uncached, DEFAULT_LLM_PRICES.uncached),
        output: toNum(p?.output, DEFAULT_LLM_PRICES.output),
      };
    }
  } catch {
    // Fall back to defaults when browser storage is unavailable or invalid.
  }
  return { ...DEFAULT_LLM_PRICES };
}

function saveLlmPrices(p: LlmPrices) {
  try {
    localStorage.setItem(PRICES_KEY, JSON.stringify(p));
  } catch {
    // The estimate still works for this session without browser storage.
  }
}

export function fmtYuan(n: number): string {
  const digits = n > 0 && n < 1 ? 4 : 2;
  return `¥${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

function formatAxis(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return Math.round(n).toString();
}

type RangePreset = "today" | "7d" | "30d" | "90d" | "180d" | "365d" | "custom";

function tokenParts(day: LlmDailyDay, normalizeVllmSplit: boolean) {
  let cached = day.cachedPrefillTokens || 0;
  let uncached = day.uncachedPrefillTokens ?? day.prefillTokens ?? 0;
  const prefill = day.prefillTokens || 0;
  const splitTotal = cached + uncached;
  if (normalizeVllmSplit && prefill > 0 && splitTotal > 0) {
    cached = (prefill * cached) / splitTotal;
    uncached = prefill - cached;
  }
  const decode = day.decodeTokens || 0;
  return { cached, uncached, decode, total: cached + uncached + decode };
}

function UsageChart({
  days,
  prices,
  normalizeVllmSplit,
}: {
  days: LlmDailyDay[];
  prices: LlmPrices;
  normalizeVllmSplit: boolean;
}) {
  const slotPx = days.length > 200 ? 6 : days.length > 90 ? 10 : 30;
  const width = Math.max(760, days.length * slotPx);
  const height = 300;
  const plot = { left: 62, right: 18, top: 18, bottom: 42 };
  const plotW = width - plot.left - plot.right;
  const plotH = height - plot.top - plot.bottom;
  const totals = days.map((day) => tokenParts(day, normalizeVllmSplit));
  const max = Math.max(1, ...totals.map((item) => item.total));
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(3, Math.min(28, slot * 0.6));
  const labelEvery =
    days.length <= 10 ? 1 : days.length <= 35 ? 2 : days.length <= 100 ? 7 : days.length <= 200 ? 14 : 30;

  if (!totals.some((item) => item.total > 0)) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted">
        No token activity recorded in this period.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated px-2 py-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: `${width}px`, width: "100%", height: "300px" }}
        role="img"
        aria-label="Daily cached prefill, uncached prefill, and decode token usage"
      >
        {[0, 0.25, 0.5, 0.75, 1].map((fraction) => {
          const y = plot.top + plotH * (1 - fraction);
          return (
            <g key={fraction}>
              <line
                x1={plot.left}
                x2={width - plot.right}
                y1={y}
                y2={y}
                stroke="var(--color-border)"
                strokeWidth="1"
              />
              <text
                x={plot.left - 10}
                y={y + 4}
                textAnchor="end"
                fill="var(--color-muted)"
                fontSize="11"
              >
                {formatAxis(max * fraction)}
              </text>
            </g>
          );
        })}
        {days.map((day, index) => {
          const item = totals[index];
          const x = plot.left + index * slot + (slot - barW) / 2;
          const cachedH = (item.cached / max) * plotH;
          const uncachedH = (item.uncached / max) * plotH;
          const decodeH = (item.decode / max) * plotH;
          const bottom = plot.top + plotH;
          const dayCost =
            (item.cached / 1e6) * prices.cached +
            (item.uncached / 1e6) * prices.uncached +
            (item.decode / 1e6) * prices.output;
          return (
            <g key={day.date}>
              <title>{`${day.date} · cached ${fmtTokens(item.cached)} · uncached ${fmtTokens(item.uncached)} · decode ${fmtTokens(item.decode)} · ${fmtYuan(dayCost)}`}</title>
              <rect x={x} y={bottom - cachedH} width={barW} height={cachedH} rx="2" fill="#38a169" />
              <rect
                x={x}
                y={bottom - cachedH - uncachedH}
                width={barW}
                height={uncachedH}
                fill="#d99a24"
              />
              <rect
                x={x}
                y={bottom - cachedH - uncachedH - decodeH}
                width={barW}
                height={decodeH}
                rx="2"
                fill="var(--color-accent)"
              />
              {(index % labelEvery === 0 || index === days.length - 1) && (
                <text
                  x={x + barW / 2}
                  y={height - 16}
                  textAnchor="middle"
                  fill="var(--color-muted)"
                  fontSize="10"
                >
                  {day.date.slice(5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

interface CostEstimateDialogProps {
  open: boolean;
  onClose: () => void;
  llm: LlmMetrics;
  sparkId: string;
  llmPort: number;
  prices: LlmPrices;
  onPricesChange: (p: LlmPrices) => void;
}

export function CostEstimateDialog({
  open,
  onClose,
  llm,
  sparkId,
  llmPort,
  prices,
  onPricesChange,
}: CostEstimateDialogProps) {
  const { mounted, visible } = useModalPresence(open);
  const [days, setDays] = useState<LlmDailyDay[]>([]);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<RangePreset>("30d");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [draft, setDraft] = useState<LlmPrices>(prices);

  useEffect(() => {
    if (open) setDraft(prices);
  }, [open, prices]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      setLoading(true);
      // days=0 requests the full stored history so the date picker and long
      // presets (90/180/365d) can reach beyond the old 30-day window.
      fetchLlmDaily(sparkId, llmPort, 0)
        .then((res) => {
          if (cancelled) return;
          const next = res.days || [];
          setDays(next);
          setStartDate((current) => current || next[0]?.date || "");
          setEndDate((current) => current || next[next.length - 1]?.date || "");
        })
        .catch(() => {
          if (!cancelled) setDays([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [open, sparkId, llmPort]);

  useEffect(() => {
    if (!mounted) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", handleKey);
    };
  }, [mounted, onClose]);

  const selectedDays = useMemo(() => {
    if (range === "today") return days.slice(-1);
    if (range === "7d") return days.slice(-7);
    if (range === "30d") return days.slice(-30);
    if (range === "90d") return days.slice(-90);
    if (range === "180d") return days.slice(-180);
    if (range === "365d") return days.slice(-365);
    return days.filter(
      (day) => (!startDate || day.date >= startDate) && (!endDate || day.date <= endDate)
    );
  }, [days, endDate, range, startDate]);

  const normalizeVllmSplit = llm.backend === "vllm";

  const summary = useMemo(() => {
    return selectedDays.reduce(
      (total, day) => {
        const parts = tokenParts(day, normalizeVllmSplit);
        total.cached += parts.cached;
        total.uncached += parts.uncached;
        total.decode += parts.decode;
        return total;
      },
      { cached: 0, uncached: 0, decode: 0 }
    );
  }, [normalizeVllmSplit, selectedDays]);

  const estimatedCost =
    (summary.cached / 1e6) * draft.cached +
    (summary.uncached / 1e6) * draft.uncached +
    (summary.decode / 1e6) * draft.output;

  const updatePrice = (key: keyof LlmPrices, raw: string) => {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    saveLlmPrices(next);
    onPricesChange(next);
  };

  if (!mounted) return null;

  const rangeLabel = selectedDays.length
    ? `${selectedDays[0].date} - ${selectedDays[selectedDays.length - 1].date}`
    : "No dates selected";

  return createPortal(
    <div
      className={`modal-overlay${visible ? " is-open" : ""}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal-sheet"
        style={{ maxWidth: "72rem", maxHeight: "92dvh" }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cost-title"
      >
        <div className="modal-sheet__header flex items-center justify-between gap-3">
          <div>
            <div id="cost-title" className="text-base">Usage details</div>
            <div className="mt-0.5 text-[11px] font-normal text-muted">
              {sparkId} · port {llmPort} · {llm.backend || "LLM"}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-lg font-normal text-muted hover:bg-surface-hover hover:text-text"
            aria-label="Close usage details"
          >
            ×
          </button>
        </div>

        <div className="modal-sheet__body space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            {([
              ["today", "Today"],
              ["7d", "Last 7 days"],
              ["30d", "Last 30 days"],
              ["90d", "Last 90 days"],
              ["180d", "Last 180 days"],
              ["365d", "Last 365 days"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setRange(value)}
                className={`rounded-md border px-3 py-2 text-xs font-medium transition-colors ${
                  range === value
                    ? "border-accent bg-accent-soft text-text"
                    : "border-border bg-surface-elevated text-muted hover:text-text"
                }`}
              >
                {label}
              </button>
            ))}
            <div className="mx-1 hidden h-7 w-px bg-border sm:block" />
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="date"
                value={startDate}
                min={days[0]?.date}
                max={endDate || days[days.length - 1]?.date}
                onChange={(event) => {
                  setStartDate(event.target.value);
                  setRange("custom");
                }}
                className="rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-text outline-none focus:border-accent"
              />
              <span>to</span>
              <input
                type="date"
                value={endDate}
                min={startDate || days[0]?.date}
                max={days[days.length - 1]?.date}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setRange("custom");
                }}
                className="rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-text outline-none focus:border-accent"
              />
            </label>
            <span className="ml-auto text-xs font-tabular text-muted">{rangeLabel}</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-border bg-surface-elevated p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted">Cached prefill</div>
              <div className="mt-2 font-tabular text-xl font-semibold text-text">{fmtTokens(summary.cached)}</div>
            </div>
            <div className="rounded-xl border border-border bg-surface-elevated p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted">Uncached prefill</div>
              <div className="mt-2 font-tabular text-xl font-semibold text-text">{fmtTokens(summary.uncached)}</div>
            </div>
            <div className="rounded-xl border border-border bg-surface-elevated p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted">Decode</div>
              <div className="mt-2 font-tabular text-xl font-semibold text-text">{fmtTokens(summary.decode)}</div>
            </div>
            <div className="rounded-xl border border-accent/40 bg-accent-soft p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted">Estimated cost</div>
              <div className="mt-2 font-tabular text-xl font-semibold text-accent">{fmtYuan(estimatedCost)}</div>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-text">Daily token usage</div>
                <div className="text-[11px] text-muted">Stacked bars show the proportion of each token type.</div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#38a169]" />Cached prefill</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#d99a24]" />Uncached prefill</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent" />Decode</span>
              </div>
            </div>
            {loading && days.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-muted">Loading usage...</div>
            ) : (
              <UsageChart
                days={selectedDays}
                prices={draft}
                normalizeVllmSplit={normalizeVllmSplit}
              />
            )}
          </div>

          <div className="rounded-xl border border-border p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold text-text">Estimate rates</div>
                <div className="text-[10px] text-muted">¥ per million tokens · saved in this browser</div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = { ...DEFAULT_LLM_PRICES };
                  setDraft(next);
                  saveLlmPrices(next);
                  onPricesChange(next);
                }}
                className="text-[11px] text-muted hover:text-text"
              >
                Reset defaults
              </button>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {([
                ["cached", "Cached prefill"],
                ["uncached", "Uncached prefill"],
                ["output", "Decode"],
              ] as const).map(([key, label]) => (
                <label key={key} className="text-[11px] text-muted">
                  {label}
                  <input
                    type="number"
                    min={0}
                    step="any"
                    value={draft[key]}
                    onChange={(event) => updatePrice(key, event.target.value)}
                    className="mt-1 w-full rounded-md border border-border bg-surface-elevated px-3 py-2 font-tabular text-sm text-text outline-none focus:border-accent"
                  />
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-sheet__footer">
          <p className="text-[10px] text-muted">Usage history is retained indefinitely. No points or credits are calculated.</p>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-md bg-accent px-4 py-2 text-xs font-medium text-white hover:bg-accent-hover"
          >
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
