/**
 * Daily LLM tok/s rollups (decode + prefill, plus cached/uncached when the backend splits)
 * and per-day token totals.
 *
 * Busy samples only (rate > 0). Persists to config/llm-daily.json. History is retained
 * permanently by default so token consumption can be audited over any date range; set
 * SPARKDASH_LLM_DAILY_RETENTION_DAYS to a positive integer to cap each series.
 */
import fs from "fs";
import { LLM_DAILY_JSON_PATH } from "../config.js";
import { atomicWrite } from "../util/atomicWrite.js";

/** Days of history to keep per series. 0 (default) = keep everything. */
const RETENTION_DAYS = Math.max(
  0,
  Math.floor(Number(process.env.SPARKDASH_LLM_DAILY_RETENTION_DAYS) || 0)
);
/** Upper bound for one calendar query, so a bad client cannot ask for unbounded arrays. */
const MAX_QUERY_DAYS = 3660;
const FLUSH_MS = 30_000;
const BUSY_EPS = 0.05;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function utcDateKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function seriesKey(sparkId, port) {
  return `${sparkId}:${port}`;
}

function emptyDay() {
  return {
    decodeMax: 0,
    decodeSum: 0,
    decodeN: 0,
    prefillMax: 0,
    prefillSum: 0,
    prefillN: 0,
    cachedPrefillMax: 0,
    cachedPrefillSum: 0,
    cachedPrefillN: 0,
    uncachedPrefillMax: 0,
    uncachedPrefillSum: 0,
    uncachedPrefillN: 0,
    hasSplit: false,
    // Daily cumulative token totals (deltas of the probe's counters)
    decodeTokens: 0,
    prefillTokens: 0,
    cachedPrefillTokens: 0,
    uncachedPrefillTokens: 0,
  };
}

function ingest(day, field, value) {
  if (value == null || !Number.isFinite(value) || value <= BUSY_EPS) return false;
  const v = round2(value);
  day[`${field}Max`] = Math.max(day[`${field}Max`] || 0, v);
  day[`${field}Sum`] = round2((day[`${field}Sum`] || 0) + v);
  day[`${field}N`] = (day[`${field}N`] || 0) + 1;
  return true;
}

function avg(sum, n) {
  if (!n) return null;
  return round2(sum / n);
}

function publicDay(date, day) {
  if (!day) {
    return {
      date,
      decodeMax: 0,
      decodeAvg: null,
      prefillMax: 0,
      prefillAvg: null,
      cachedPrefillMax: null,
      cachedPrefillAvg: null,
      uncachedPrefillMax: null,
      uncachedPrefillAvg: null,
      decodeTokens: 0,
      prefillTokens: 0,
      cachedPrefillTokens: null,
      uncachedPrefillTokens: null,
    };
  }
  const split = Boolean(day.hasSplit);
  return {
    date,
    decodeMax: round2(day.decodeMax || 0),
    decodeAvg: avg(day.decodeSum, day.decodeN),
    prefillMax: round2(day.prefillMax || 0),
    prefillAvg: avg(day.prefillSum, day.prefillN),
    cachedPrefillMax: split ? round2(day.cachedPrefillMax || 0) : null,
    cachedPrefillAvg: split ? avg(day.cachedPrefillSum, day.cachedPrefillN) : null,
    uncachedPrefillMax: split ? round2(day.uncachedPrefillMax || 0) : null,
    uncachedPrefillAvg: split ? avg(day.uncachedPrefillSum, day.uncachedPrefillN) : null,
    decodeTokens: round2(day.decodeTokens || 0),
    prefillTokens: round2(day.prefillTokens || 0),
    cachedPrefillTokens: split ? round2(day.cachedPrefillTokens || 0) : null,
    uncachedPrefillTokens: split ? round2(day.uncachedPrefillTokens || 0) : null,
  };
}

function pruneSeries(daysByDate) {
  if (RETENTION_DAYS <= 0) return daysByDate;
  const keys = Object.keys(daysByDate).sort();
  if (keys.length <= RETENTION_DAYS) return daysByDate;
  const keep = new Set(keys.slice(-RETENTION_DAYS));
  const next = {};
  for (const k of keys) {
    if (keep.has(k)) next[k] = daysByDate[k];
  }
  return next;
}

export class LlmDailyStore {
  /**
   * @param {string} [filePath]
   */
  constructor(filePath = LLM_DAILY_JSON_PATH) {
    this.filePath = filePath;
    /** @type {Record<string, Record<string, ReturnType<typeof emptyDay>>>} */
    this._data = {};
    this._dirty = false;
    this._flushTimer = null;
    /** Last-seen cumulative token counters per series (for per-day deltas). */
    this._lastTokens = {};
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && typeof raw === "object") this._data = raw;
    } catch {
      this._data = {};
    }
  }

  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this.flush();
    }, FLUSH_MS);
    this._flushTimer.unref?.();
  }

  flush() {
    if (!this._dirty) return;
    try {
      atomicWrite(this.filePath, JSON.stringify(this._data));
      this._dirty = false;
    } catch (err) {
      console.error("[LlmDaily] write failed:", err.message);
    }
  }

  /**
   * @param {string} sparkId
   * @param {number} port
   * @param {{ available?: boolean, generationTps?: number, prefillTps?: number, cachedPrefillTps?: number|null, uncachedPrefillTps?: number|null, totalOutputTokens?: number, totalPrefillTokens?: number, totalCachedPrefillTokens?: number|null, totalUncachedPrefillTokens?: number|null }} metrics
   * @param {Date} [now]
   */
  record(sparkId, port, metrics, now = new Date()) {
    if (!sparkId || !Number.isInteger(port)) return;
    if (!metrics || metrics.available === false) return;

    const key = seriesKey(sparkId, port);
    const date = utcDateKey(now);
    if (!this._data[key]) this._data[key] = {};
    if (!this._data[key][date]) this._data[key][date] = emptyDay();
    const day = this._data[key][date];

    let changed = false;
    changed = ingest(day, "decode", metrics.generationTps) || changed;
    changed = ingest(day, "prefill", metrics.prefillTps) || changed;
    if (metrics.cachedPrefillTps != null || metrics.uncachedPrefillTps != null) {
      if (!day.hasSplit) {
        day.hasSplit = true;
        changed = true;
      }
      changed = ingest(day, "cachedPrefill", metrics.cachedPrefillTps) || changed;
      changed = ingest(day, "uncachedPrefill", metrics.uncachedPrefillTps) || changed;
    }
    const hasTokenSplit =
      metrics.totalCachedPrefillTokens != null || metrics.totalUncachedPrefillTokens != null;
    if (hasTokenSplit && !day.hasSplit) {
      day.hasSplit = true;
      changed = true;
    }
    if (this._ingestTokenTotals(key, date, day, metrics)) changed = true;

    if (!changed) return;
    this._data[key] = pruneSeries(this._data[key]);
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Accumulate per-day cumulative token totals (decode / prefill / cached+uncached
   * split) from deltas of the probe's counters. Reseeds across day boundaries so
   * tokens are attributed to the UTC day they were produced in; a gap/restart also
   * reseeds (no cross-gap attribution). Split fields may be null when the backend
   * does not report them.
   * @param {string} key
   * @param {string} date
   * @param {ReturnType<typeof emptyDay>} day
   * @param {{ totalOutputTokens?: number, totalPrefillTokens?: number, totalCachedPrefillTokens?: number|null, totalUncachedPrefillTokens?: number|null }} metrics
   * @returns {boolean} true when any tokens were added
   */
  _ingestTokenTotals(key, date, day, metrics) {
    const cur = {
      out: metrics.totalOutputTokens,
      pref: metrics.totalPrefillTokens,
      cached: metrics.totalCachedPrefillTokens,
      uncached: metrics.totalUncachedPrefillTokens,
    };
    const last = this._lastTokens[key];
    if (
      last == null ||
      last.date !== date ||
      !Number.isFinite(cur.out) ||
      !Number.isFinite(cur.pref)
    ) {
      this._lastTokens[key] = { date, ...cur };
      return false;
    }
    let changed = false;
    const acc = (target, curV, lastV) => {
      if (curV == null || lastV == null || !Number.isFinite(curV)) return;
      const d = curV - lastV;
      if (d > 0) {
        day[target] = round2((day[target] || 0) + d);
        changed = true;
      }
    };
    acc("decodeTokens", cur.out, last.out);
    acc("prefillTokens", cur.pref, last.pref);
    acc("cachedPrefillTokens", cur.cached, last.cached);
    acc("uncachedPrefillTokens", cur.uncached, last.uncached);
    this._lastTokens[key] = { date, ...cur };
    return changed;
  }

  /**
   * Calendar-aligned UTC day series (zeros for missing days). `days` defaults to 14.
   * Pass 0 (or any non-positive / non-finite value) to return the full stored history,
   * capped at MAX_QUERY_DAYS. Returns an empty array when nothing is stored.
   * @param {string} sparkId
   * @param {number} port
   * @param {{ days?: number, now?: Date }} [opts]
   */
  getSeries(sparkId, port, opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const key = seriesKey(sparkId, port);
    const stored = this._data[key] || {};
    const requested = opts.days == null ? 14 : Number(opts.days);
    let n;
    if (Number.isFinite(requested) && requested > 0) {
      n = Math.min(MAX_QUERY_DAYS, Math.floor(requested));
    } else {
      // "all": span from the earliest stored day through today.
      const earliest = Object.keys(stored).sort()[0];
      if (!earliest) return { sparkId, port, days: [] };
      const from = Date.parse(`${earliest}T00:00:00.000Z`);
      if (!Number.isFinite(from)) return { sparkId, port, days: [] };
      const span = Math.floor((now.getTime() - from) / 86400000) + 1;
      n = Math.max(1, Math.min(MAX_QUERY_DAYS, span));
    }
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const date = utcDateKey(d);
      out.push(publicDay(date, stored[date]));
    }
    return { sparkId, port, days: out };
  }
}

export const llmDaily = new LlmDailyStore();
