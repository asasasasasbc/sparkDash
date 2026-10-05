/**
 * LLM usage history.
 *
 * Token deltas of the probe's cumulative counters are bucketed by UTC hour and kept
 * permanently, so the UI can slice them into any timezone. Per-day busy tok/s rollups
 * (decode / prefill, plus cached/uncached when the backend splits) are also kept, keyed
 * by the configured local day (settings.llmHistoryTzOffsetMinutes, default UTC+8).
 *
 * Busy samples only (rate > 0). Persists to config/llm-daily.json as
 *   { "<sparkId>:<port>": { days: { "<local-day>": rateRollup },
 *                           hours: { "<utc-hour>": tokenBucket } } }
 * Legacy flat files ({ "<day>": dayRollup } with token fields) are migrated on load.
 * History is retained permanently by default; set SPARKDASH_LLM_DAILY_RETENTION_DAYS
 * to a positive integer to cap each series.
 */
import fs from "fs";
import { LLM_DAILY_JSON_PATH } from "../config.js";
import { getSettings } from "../settings.js";
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
/**
 * A gap longer than this between two samples is treated as a restart/outage: the
 * baseline is reseeded and the counter jump is not attributed to a single hour.
 */
const GAP_MS = 10 * 60_000;
const DEFAULT_TZ_OFFSET_MIN = 480;
const DAY_MS = 86_400_000;

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Offset in minutes east of UTC, clamped to UTC-12 … UTC+14. */
function clampTz(min) {
  const n = Math.floor(Number(min));
  if (!Number.isFinite(n)) return DEFAULT_TZ_OFFSET_MIN;
  return Math.max(-720, Math.min(840, n));
}

/** Configured local-day offset (settings), live so a Settings change applies at once. */
function configuredTzOffset() {
  try {
    return clampTz(getSettings().llmHistoryTzOffsetMinutes);
  } catch {
    return DEFAULT_TZ_OFFSET_MIN;
  }
}

/** "YYYY-MM-DD" of the local day containing `ms`. */
function localDayKey(ms, tzMin) {
  return new Date(ms + tzMin * 60_000).toISOString().slice(0, 10);
}

/** "YYYY-MM-DDTHH" UTC hour key of a Date. */
function utcHourKey(d) {
  return d.toISOString().slice(0, 13);
}

function hourKeyToMs(hourKey) {
  return Date.parse(`${hourKey}:00:00Z`);
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
  };
}

function emptyEntry() {
  return { days: {}, hours: {} };
}

function emptyBucket() {
  return { decode: 0, prefill: 0, cached: 0, uncached: 0, split: false };
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

/**
 * @param {string} date Local day label.
 * @param {ReturnType<typeof emptyDay>|undefined} day Busy-rate rollup.
 * @param {{ decode:number, prefill:number, cached:number, uncached:number, split:boolean }|undefined} tokens Token totals for that local day.
 */
function publicDay(date, day, tokens) {
  const rateSplit = Boolean(day && day.hasSplit);
  const tokenSplit = Boolean(tokens && tokens.split);
  return {
    date,
    decodeMax: round2(day?.decodeMax || 0),
    decodeAvg: avg(day?.decodeSum, day?.decodeN),
    prefillMax: round2(day?.prefillMax || 0),
    prefillAvg: avg(day?.prefillSum, day?.prefillN),
    cachedPrefillMax: rateSplit ? round2(day.cachedPrefillMax || 0) : null,
    cachedPrefillAvg: rateSplit ? avg(day.cachedPrefillSum, day.cachedPrefillN) : null,
    uncachedPrefillMax: rateSplit ? round2(day.uncachedPrefillMax || 0) : null,
    uncachedPrefillAvg: rateSplit ? avg(day.uncachedPrefillSum, day.uncachedPrefillN) : null,
    decodeTokens: round2(tokens?.decode || 0),
    prefillTokens: round2(tokens?.prefill || 0),
    cachedPrefillTokens: tokenSplit ? round2(tokens.cached || 0) : null,
    uncachedPrefillTokens: tokenSplit ? round2(tokens.uncached || 0) : null,
  };
}

/** Sum hourly UTC buckets into a map of local day → token totals. */
function aggregateTokensByDay(hours, tzMin) {
  const map = new Map();
  for (const [key, bucket] of Object.entries(hours)) {
    const ms = hourKeyToMs(key);
    if (!Number.isFinite(ms)) continue;
    const day = localDayKey(ms, tzMin);
    let entry = map.get(day);
    if (!entry) {
      entry = { decode: 0, prefill: 0, cached: 0, uncached: 0, split: false };
      map.set(day, entry);
    }
    entry.decode = round2(entry.decode + (bucket.decode || 0));
    entry.prefill = round2(entry.prefill + (bucket.prefill || 0));
    entry.cached = round2(entry.cached + (bucket.cached || 0));
    entry.uncached = round2(entry.uncached + (bucket.uncached || 0));
    entry.split = entry.split || Boolean(bucket.split);
  }
  return map;
}

/** Earliest stored timestamp (ms) across day and hour keys, or null. */
function earliestMs(entry) {
  let min = null;
  for (const key of Object.keys(entry.days)) {
    const t = Date.parse(`${key}T00:00:00Z`);
    if (Number.isFinite(t) && (min == null || t < min)) min = t;
  }
  for (const key of Object.keys(entry.hours)) {
    const t = hourKeyToMs(key);
    if (Number.isFinite(t) && (min == null || t < min)) min = t;
  }
  return min;
}

function pruneEntry(entry) {
  if (RETENTION_DAYS <= 0) return entry;
  const cutoff = Date.now() - RETENTION_DAYS * DAY_MS;
  const days = {};
  for (const [k, v] of Object.entries(entry.days)) {
    if (Date.parse(`${k}T00:00:00Z`) >= cutoff) days[k] = v;
  }
  const hours = {};
  for (const [k, v] of Object.entries(entry.hours)) {
    const t = hourKeyToMs(k);
    if (Number.isFinite(t) && t >= cutoff) hours[k] = v;
  }
  return { days, hours };
}

/** Migrate a legacy flat day map into the current { days, hours } shape. */
function migrateSeries(value) {
  const days = {};
  const hours = {};
  for (const [date, day] of Object.entries(value)) {
    if (!day || typeof day !== "object") continue;
    const {
      decodeTokens,
      prefillTokens,
      cachedPrefillTokens,
      uncachedPrefillTokens,
      ...rate
    } = day;
    days[date] = rate;
    const tokenTotal = (decodeTokens || 0) + (prefillTokens || 0);
    if (tokenTotal > 0 || day.hasSplit) {
      // Legacy data has no hour resolution; anchor it at 12:00 UTC, which keeps the
      // day label stable for any offset in [-12, +12] (the common cases, incl. +8).
      hours[`${date}T12`] = {
        decode: decodeTokens || 0,
        prefill: prefillTokens || 0,
        cached: cachedPrefillTokens || 0,
        uncached: uncachedPrefillTokens || 0,
        split: Boolean(day.hasSplit),
      };
    }
  }
  return { days, hours };
}

export class LlmDailyStore {
  /**
   * @param {string} [filePath]
   */
  constructor(filePath = LLM_DAILY_JSON_PATH) {
    this.filePath = filePath;
    /** @type {Record<string, ReturnType<typeof emptyEntry>>} */
    this._data = {};
    this._dirty = false;
    this._flushTimer = null;
    /** Last-seen cumulative token counters per series (for deltas). */
    this._lastTokens = {};
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (!raw || typeof raw !== "object") return;
      const next = {};
      let migrated = false;
      for (const [key, value] of Object.entries(raw)) {
        if (!value || typeof value !== "object") continue;
        if (value.days || value.hours) {
          next[key] = { days: value.days || {}, hours: value.hours || {} };
        } else {
          next[key] = migrateSeries(value);
          migrated = true;
        }
      }
      this._data = next;
      if (migrated) {
        this._dirty = true;
        this.flush();
        console.log("[LlmDaily] migrated legacy history to hourly format");
      }
    } catch {
      this._data = {};
    }
  }

  _entry(key) {
    let entry = this._data[key];
    if (!entry || typeof entry !== "object" || (!entry.days && !entry.hours)) {
      entry = emptyEntry();
      this._data[key] = entry;
    }
    if (!entry.days) entry.days = {};
    if (!entry.hours) entry.hours = {};
    return entry;
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
    const nowMs = now.getTime();
    const date = localDayKey(nowMs, configuredTzOffset());
    const entry = this._entry(key);
    if (!entry.days[date]) entry.days[date] = emptyDay();
    const day = entry.days[date];

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
    if (this._ingestTokenTotals(key, entry, utcHourKey(now), metrics, nowMs)) changed = true;

    if (!changed) return;
    this._data[key] = pruneEntry(entry);
    this._dirty = true;
    this._scheduleFlush();
  }

  /**
   * Accumulate token deltas into the current UTC hour bucket. Deliberately keyed by
   * hour (not day) so the client can re-slice into any timezone. A long gap between
   * samples reseeds the baseline instead of attributing the jump to one hour.
   * Split fields may be null when the backend does not report them.
   * @param {string} key
   * @param {ReturnType<typeof emptyEntry>} entry
   * @param {string} hourKey
   * @param {object} metrics
   * @param {number} nowMs
   * @returns {boolean} true when any tokens were added
   */
  _ingestTokenTotals(key, entry, hourKey, metrics, nowMs) {
    const cur = {
      out: metrics.totalOutputTokens,
      pref: metrics.totalPrefillTokens,
      cached: metrics.totalCachedPrefillTokens,
      uncached: metrics.totalUncachedPrefillTokens,
    };
    const last = this._lastTokens[key];
    const readable = Number.isFinite(cur.out) && Number.isFinite(cur.pref);
    if (last == null || !readable || nowMs - last.t > GAP_MS) {
      this._lastTokens[key] = { t: nowMs, ...cur };
      return false;
    }
    let changed = false;
    const bucket = entry.hours[hourKey] || emptyBucket();
    const add = (field, curV, lastV) => {
      if (curV == null || lastV == null || !Number.isFinite(curV)) return;
      const delta = curV - lastV;
      if (delta > 0) {
        bucket[field] = round2((bucket[field] || 0) + delta);
        changed = true;
      }
    };
    add("decode", cur.out, last.out);
    add("prefill", cur.pref, last.pref);
    add("cached", cur.cached, last.cached);
    add("uncached", cur.uncached, last.uncached);
    if (changed) {
      if (cur.cached != null || cur.uncached != null) bucket.split = true;
      entry.hours[hourKey] = bucket;
    }
    this._lastTokens[key] = { t: nowMs, ...cur };
    return changed;
  }

  /**
   * Calendar-aligned daily series (zeros for missing days), timezone-aware. `days`
   * defaults to 14; pass 0 (or a non-positive/non-finite value) for the full stored
   * history, capped at MAX_QUERY_DAYS. Token totals are aggregated from hourly
   * buckets at `tzOffsetMin` (default: the configured settings offset).
   * @param {string} sparkId
   * @param {number} port
   * @param {{ days?: number, now?: Date, tzOffsetMin?: number }} [opts]
   */
  getSeries(sparkId, port, opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const nowMs = now.getTime();
    const tzMin = clampTz(opts.tzOffsetMin ?? configuredTzOffset());
    const key = seriesKey(sparkId, port);
    const entry = this._data[key] || emptyEntry();
    const tokenByDay = aggregateTokensByDay(entry.hours, tzMin);
    const requested = opts.days == null ? 14 : Number(opts.days);
    let n;
    if (Number.isFinite(requested) && requested > 0) {
      n = Math.min(MAX_QUERY_DAYS, Math.floor(requested));
    } else {
      const earliest = earliestMs(entry);
      if (earliest == null) return { sparkId, port, days: [] };
      const span = Math.floor((nowMs - earliest) / DAY_MS) + 1;
      n = Math.max(1, Math.min(MAX_QUERY_DAYS, span));
    }
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const date = localDayKey(nowMs - i * DAY_MS, tzMin);
      out.push(publicDay(date, entry.days[date], tokenByDay.get(date)));
    }
    return { sparkId, port, days: out };
  }

  /**
   * Sparse hourly token buckets with UTC hour keys ("YYYY-MM-DDTHH"), so the client
   * can slice by any timezone. `days` defaults to 30; pass 0 for the full history.
   * @param {string} sparkId
   * @param {number} port
   * @param {{ days?: number, now?: Date }} [opts]
   */
  getHourly(sparkId, port, opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const nowMs = now.getTime();
    const key = seriesKey(sparkId, port);
    const entry = this._data[key] || emptyEntry();
    const requested = opts.days == null ? 30 : Number(opts.days);
    let cutoff = 0;
    if (Number.isFinite(requested) && requested > 0) {
      cutoff = nowMs - Math.min(MAX_QUERY_DAYS, Math.floor(requested)) * DAY_MS;
    }
    const upper = nowMs + 3_600_000;
    const hours = [];
    for (const [hour, bucket] of Object.entries(entry.hours)) {
      const t = hourKeyToMs(hour);
      if (!Number.isFinite(t) || t < cutoff || t > upper) continue;
      hours.push({
        hour,
        decode: round2(bucket.decode || 0),
        prefill: round2(bucket.prefill || 0),
        cached: bucket.split ? round2(bucket.cached || 0) : null,
        uncached: bucket.split ? round2(bucket.uncached || 0) : null,
        split: Boolean(bucket.split),
      });
    }
    hours.sort((a, b) => (a.hour < b.hour ? -1 : a.hour > b.hour ? 1 : 0));
    return { sparkId, port, hours };
  }
}

export const llmDaily = new LlmDailyStore();
