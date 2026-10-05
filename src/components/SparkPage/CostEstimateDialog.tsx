import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { fetchLlmHourly } from "../../api/client";
import type { LlmHourlyBucket, LlmMetrics } from "../../api/types";
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
const TZ_KEY = "sparkdash.llmTzOffsetMinutes";
const POLL_MS = 60_000;
const DAY_MS = 86_400_000;
const DEFAULT_TZ_MIN = 480;

/** Common fixed offsets (minutes east of UTC) offered in the picker. */
const TZ_OPTIONS: Array<{ label: string; value: number }> = [
  { label: "UTC−12", value: -720 },
  { label: "UTC−8", value: -480 },
  { label: "UTC−5", value: -300 },
  { label: "UTC+0", value: 0 },
  { label: "UTC+1", value: 60 },
  { label: "UTC+3", value: 180 },
  { label: "UTC+5:30", value: 330 },
  { label: "UTC+7", value: 420 },
  { label: "UTC+8 (Beijing)", value: 480 },
  { label: "UTC+9", value: 540 },
  { label: "UTC+10", value: 600 },
  { label: "UTC+12", value: 720 },
  { label: "UTC+14", value: 840 },
];

function clampTz(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_TZ_MIN;
  return Math.max(-720, Math.min(840, Math.round(min)));
}

function tzLabel(min: number): string {
  const found = TZ_OPTIONS.find((o) => o.value === min);
  if (found) return found.label;
  const sign = min < 0 ? "−" : "+";
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, "0")}` : ""}`;
}

/** "YYYY-MM-DD" of the local day containing `ms` at the given offset. */
function localDayKey(ms: number, tzMin: number): string {
  return new Date(ms + tzMin * 60_000).toISOString().slice(0, 10);
}

/** Local hour-of-day (0–23) for `ms` at the given offset. */
function localHour(ms: number, tzMin: number): number {
  return new Date(ms + tzMin * 60_000).getUTCHours();
}

/** UTC hour key "YYYY-MM-DDTHH" → epoch ms. */
function hourKeyToMs(hour: string): number {
  return Date.parse(`${hour}:00:00Z`);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

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

function loadTzOffset(): number {
  try {
    const raw = localStorage.getItem(TZ_KEY);
    if (raw != null) return clampTz(Number(raw));
  } catch {
    // Fall back to the default offset.
  }
  return DEFAULT_TZ_MIN;
}

function saveTzOffset(min: number) {
  try {
    localStorage.setItem(TZ_KEY, String(min));
  } catch {
    // Ignore unavailable browser storage.
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

/** Raw token totals accumulated over a set of hours. */
interface TokenTotals {
  cached: number;
  uncached: number;
  decode: number;
  prefill: number;
}

interface TokenParts {
  cached: number;
  uncached: number;
  decode: number;
}

function emptyTotals(): TokenTotals {
  return { cached: 0, uncached: 0, decode: 0, prefill: 0 };
}

function addBucket(totals: TokenTotals, bucket: LlmHourlyBucket) {
  totals.decode += bucket.decode || 0;
  totals.prefill += bucket.prefill || 0;
  if (bucket.split) {
    totals.cached += bucket.cached || 0;
    totals.uncached += bucket.uncached || 0;
  } else {
    totals.uncached += bucket.prefill || 0;
  }
}

/**
 * vLLM reports a cached/uncached split whose sum can differ from the total prefill
 * count; normalize it back onto the prefill total so the parts are comparable.
 */
function normalizeParts(raw: TokenTotals, normalize: boolean): TokenParts {
  let cached = raw.cached;
  let uncached = raw.uncached;
  const splitTotal = cached + uncached;
  if (normalize && raw.prefill > 0 && splitTotal > 0) {
    cached = (raw.prefill * cached) / splitTotal;
    uncached = raw.prefill - cached;
  }
  return { cached, uncached, decode: raw.decode };
}

interface Bar {
  label: string;
  fullLabel: string;
  cached: number;
  uncached: number;
  decode: number;
  total: number;
}

function costOf(bar: Bar, prices: LlmPrices): number {
  return (
    (bar.cached / 1e6) * prices.cached +
    (bar.uncached / 1e6) * prices.uncached +
    (bar.decode / 1e6) * prices.output
  );
}

function StackedBars({
  bars,
  prices,
  slotPx,
  labelEvery,
  emptyText,
  ariaLabel,
}: {
  bars: Bar[];
  prices: LlmPrices;
  slotPx: number;
  labelEvery: number;
  emptyText: string;
  ariaLabel: string;
}) {
  const width = Math.max(760, bars.length * slotPx);
  const height = 300;
  const plot = { left: 62, right: 18, top: 18, bottom: 42 };
  const plotW = width - plot.left - plot.right;
  const plotH = height - plot.top - plot.bottom;
  const max = Math.max(1, ...bars.map((b) => b.total));
  const slot = plotW / Math.max(1, bars.length);
  const barW = Math.max(3, Math.min(28, slot * 0.6));

  if (!bars.some((b) => b.total > 0)) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted">
        {emptyText}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface-elevated px-2 py-3">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ minWidth: `${width}px`, width: "100%", height: "300px" }}
        role="img"
        aria-label={ariaLabel}
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
        {bars.map((bar, index) => {
          const x = plot.left + index * slot + (slot - barW) / 2;
          const cachedH = (bar.cached / max) * plotH;
          const uncachedH = (bar.uncached / max) * plotH;
          const decodeH = (bar.decode / max) * plotH;
          const bottom = plot.top + plotH;
          return (
            <g key={bar.label}>
              <title>{`${bar.fullLabel} · cached ${fmtTokens(bar.cached)} · uncached ${fmtTokens(bar.uncached)} · decode ${fmtTokens(bar.decode)} · ${fmtYuan(costOf(bar, prices))}`}</title>
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
              {(index % labelEvery === 0 || index === bars.length - 1) && (
                <text
                  x={x + barW / 2}
                  y={height - 16}
                  textAnchor="middle"
                  fill="var(--color-muted)"
                  fontSize="10"
                >
                  {bar.label}
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
  const [hours, setHours] = useState<LlmHourlyBucket[]>([]);
  const [loading, setLoading] = useState(false);
  const [range, setRange] = useState<RangePreset>("30d");
  const [tzMin, setTzMin] = useState<number>(loadTzOffset);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [granularity, setGranularity] = useState<"hourly" | "daily">("hourly");
  const [draft, setDraft] = useState<LlmPrices>(prices);

  useEffect(() => {
    if (open) setDraft(prices);
  }, [open, prices]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const load = () => {
      setLoading(true);
      // days=0 requests the full stored history; buckets are sparse (only active hours).
      fetchLlmHourly(sparkId, llmPort, 0)
        .then((res) => {
          if (!cancelled) setHours(res.hours || []);
        })
        .catch(() => {
          if (!cancelled) setHours([]);
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

  const normalize = llm.backend === "vllm";

  /** Local days with token activity, aggregated at the selected offset. */
  const dailyTotals = useMemo(() => {
    const map = new Map<string, TokenTotals>();
    for (const bucket of hours) {
      const ms = hourKeyToMs(bucket.hour);
      if (!Number.isFinite(ms)) continue;
      const key = localDayKey(ms, tzMin);
      let totals = map.get(key);
      if (!totals) {
        totals = emptyTotals();
        map.set(key, totals);
      }
      addBucket(totals, bucket);
    }
    return map;
  }, [hours, tzMin]);

  /** Calendar day keys from the earliest stored day (or 365 days back) through today. */
  const dayKeys = useMemo(() => {
    const nowMs = Date.now();
    let startMs = nowMs - 364 * DAY_MS;
    let earliest: number | null = null;
    for (const bucket of hours) {
      const ms = hourKeyToMs(bucket.hour);
      if (Number.isFinite(ms) && (earliest == null || ms < earliest)) earliest = ms;
    }
    if (earliest != null) startMs = Math.min(startMs, earliest);
    if (nowMs - startMs > 3660 * DAY_MS) startMs = nowMs - 3660 * DAY_MS;
    const keys: string[] = [];
    let last = "";
    for (let ms = startMs; ms <= nowMs; ms += DAY_MS) {
      const key = localDayKey(ms, tzMin);
      if (key !== last) {
        keys.push(key);
        last = key;
      }
    }
    const today = localDayKey(nowMs, tzMin);
    if (keys[keys.length - 1] !== today) keys.push(today);
    return keys;
  }, [hours, tzMin]);

  useEffect(() => {
    if (!dayKeys.length) return;
    setStartDate((current) => current || dayKeys[0]);
    setEndDate((current) => current || dayKeys[dayKeys.length - 1]);
  }, [dayKeys]);

  const selectedKeys = useMemo(() => {
    if (!dayKeys.length) return [];
    if (range === "today") return dayKeys.slice(-1);
    if (range === "7d") return dayKeys.slice(-7);
    if (range === "30d") return dayKeys.slice(-30);
    if (range === "90d") return dayKeys.slice(-90);
    if (range === "180d") return dayKeys.slice(-180);
    if (range === "365d") return dayKeys.slice(-365);
    return dayKeys.filter(
      (key) => (!startDate || key >= startDate) && (!endDate || key <= endDate)
    );
  }, [dayKeys, endDate, range, startDate]);

  const summary = useMemo(() => {
    return selectedKeys.reduce<TokenParts>(
      (total, key) => {
        const raw = dailyTotals.get(key);
        if (!raw) return total;
        const parts = normalizeParts(raw, normalize);
        total.cached += parts.cached;
        total.uncached += parts.uncached;
        total.decode += parts.decode;
        return total;
      },
      { cached: 0, uncached: 0, decode: 0 }
    );
  }, [dailyTotals, normalize, selectedKeys]);

  const estimatedCost =
    (summary.cached / 1e6) * draft.cached +
    (summary.uncached / 1e6) * draft.uncached +
    (summary.decode / 1e6) * draft.output;

  const singleDay = selectedKeys.length === 1;

  const dailyBars = useMemo<Bar[]>(() => {
    return selectedKeys.map((key) => {
      const parts = normalizeParts(dailyTotals.get(key) || emptyTotals(), normalize);
      return {
        label: key.slice(5),
        fullLabel: key,
        cached: parts.cached,
        uncached: parts.uncached,
        decode: parts.decode,
        total: parts.cached + parts.uncached + parts.decode,
      };
    });
  }, [dailyTotals, normalize, selectedKeys]);

  const hourlyBars = useMemo<Bar[] | null>(() => {
    if (!singleDay) return null;
    const key = selectedKeys[0];
    const buckets: TokenTotals[] = Array.from({ length: 24 }, () => emptyTotals());
    for (const bucket of hours) {
      const ms = hourKeyToMs(bucket.hour);
      if (!Number.isFinite(ms) || localDayKey(ms, tzMin) !== key) continue;
      addBucket(buckets[localHour(ms, tzMin)], bucket);
    }
    return buckets.map((raw, h) => {
      const parts = normalizeParts(raw, normalize);
      return {
        label: `${pad2(h)}:00`,
        fullLabel: `${key} ${pad2(h)}:00 ${tzLabel(tzMin)}`,
        cached: parts.cached,
        uncached: parts.uncached,
        decode: parts.decode,
        total: parts.cached + parts.uncached + parts.decode,
      };
    });
  }, [hours, normalize, selectedKeys, singleDay, tzMin]);

  const showHourly = singleDay && granularity === "hourly" && hourlyBars != null;
  const bars: Bar[] = showHourly && hourlyBars ? hourlyBars : dailyBars;
  const slotPx = bars.length > 200 ? 6 : bars.length > 90 ? 10 : 30;
  const labelEvery =
    bars.length <= 10 ? 1 : bars.length <= 35 ? 2 : bars.length <= 100 ? 7 : bars.length <= 200 ? 14 : 30;

  const updatePrice = (key: keyof LlmPrices, raw: string) => {
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isFinite(value) || value < 0) return;
    const next = { ...draft, [key]: value };
    setDraft(next);
    saveLlmPrices(next);
    onPricesChange(next);
  };

  if (!mounted) return null;

  const rangeLabel = selectedKeys.length
    ? `${selectedKeys[0]} - ${selectedKeys[selectedKeys.length - 1]}`
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
              {sparkId} · port {llmPort} · {llm.backend || "LLM"} · {tzLabel(tzMin)}
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
                min={dayKeys[0]}
                max={endDate || dayKeys[dayKeys.length - 1]}
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
                min={startDate || dayKeys[0]}
                max={dayKeys[dayKeys.length - 1]}
                onChange={(event) => {
                  setEndDate(event.target.value);
                  setRange("custom");
                }}
                className="rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-text outline-none focus:border-accent"
              />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <span>Timezone</span>
              <select
                value={tzMin}
                onChange={(event) => {
                  const next = clampTz(Number(event.target.value));
                  setTzMin(next);
                  saveTzOffset(next);
                  setStartDate("");
                  setEndDate("");
                }}
                className="rounded-md border border-border bg-surface-elevated px-2 py-1.5 text-text outline-none focus:border-accent"
                title="Timezone used to split usage into days"
              >
                {TZ_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
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
                <div className="text-sm font-semibold text-text">
                  {showHourly ? "Hourly token usage" : "Daily token usage"}
                </div>
                <div className="text-[11px] text-muted">
                  {showHourly
                    ? `24 hours of ${selectedKeys[0]} at ${tzLabel(tzMin)}.`
                    : "Stacked bars show the proportion of each token type."}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted">
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#38a169]" />Cached prefill</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#d99a24]" />Uncached prefill</span>
                <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-accent" />Decode</span>
                {singleDay && (
                  <span className="flex items-center gap-1">
                    {([["hourly", "Hourly"], ["daily", "Daily"]] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => setGranularity(value)}
                        className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                          granularity === value
                            ? "bg-accent text-white"
                            : "border border-border text-muted hover:text-text"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </span>
                )}
              </div>
            </div>
            {loading && hours.length === 0 ? (
              <div className="flex h-64 items-center justify-center text-sm text-muted">Loading usage...</div>
            ) : (
              <StackedBars
                bars={bars}
                prices={draft}
                slotPx={slotPx}
                labelEvery={labelEvery}
                emptyText="No token activity recorded in this period."
                ariaLabel={
                  showHourly
                    ? "Hourly cached prefill, uncached prefill, and decode token usage"
                    : "Daily cached prefill, uncached prefill, and decode token usage"
                }
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
          <p className="text-[10px] text-muted">
            Token history is stored hourly and retained indefinitely; days follow the selected timezone.
            No points or credits are calculated.
          </p>
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
