import { test } from "node:test";
import { strict as assert } from "node:assert";
import fs from "fs";
import os from "os";
import path from "path";
import { LlmDailyStore } from "../LlmDaily.js";

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-daily-"));
  return new LlmDailyStore(path.join(dir, "llm-daily.json"));
}

test("LlmDailyStore: busy samples roll into local-day max/avg", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record("spark-a", 8888, { available: true, generationTps: 10, prefillTps: 40 }, now);
  store.record("spark-a", 8888, { available: true, generationTps: 30, prefillTps: 0 }, now);
  store.record("spark-a", 8888, { available: true, generationTps: 0, prefillTps: 0 }, now);
  const { days } = store.getSeries("spark-a", 8888, { days: 1, now, tzOffsetMin: 0 });
  assert.equal(days.length, 1);
  assert.equal(days[0].date, "2026-08-16");
  assert.equal(days[0].decodeMax, 30);
  assert.equal(days[0].decodeAvg, 20);
  assert.equal(days[0].prefillMax, 40);
  assert.equal(days[0].prefillAvg, 40);
  assert.equal(days[0].cachedPrefillMax, null);
});

test("LlmDailyStore: ds4 split rates + calendar zeros", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record(
    "spark-a",
    8888,
    {
      available: true,
      generationTps: 12,
      prefillTps: 80,
      cachedPrefillTps: 400,
      uncachedPrefillTps: 80,
    },
    now
  );
  const { days } = store.getSeries("spark-a", 8888, { days: 3, now, tzOffsetMin: 0 });
  assert.equal(days.length, 3);
  assert.equal(days[0].date, "2026-08-14");
  assert.equal(days[0].decodeMax, 0);
  assert.equal(days[2].cachedPrefillMax, 400);
  assert.equal(days[2].uncachedPrefillMax, 80);
});

test("LlmDailyStore: skips unavailable probes", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record("spark-a", 8888, { available: false, generationTps: 99 }, now);
  const { days } = store.getSeries("spark-a", 8888, { days: 1, now, tzOffsetMin: 0 });
  assert.equal(days[0].decodeMax, 0);
  assert.equal(days[0].decodeAvg, null);
});

test("LlmDailyStore: cumulative token totals roll into per-day deltas", () => {
  const store = tmpStore();
  const now = new Date("2026-08-16T12:00:00.000Z");
  const base = {
    available: true,
    generationTps: 10,
    prefillTps: 40,
    totalOutputTokens: 1000,
    totalPrefillTokens: 2000,
    totalCachedPrefillTokens: 800,
    totalUncachedPrefillTokens: 1200,
  };
  store.record("spark-a", 8888, base, now);
  store.record(
    "spark-a",
    8888,
    {
      available: true,
      generationTps: 15,
      prefillTps: 50,
      totalOutputTokens: 1120,
      totalPrefillTokens: 2210,
      totalCachedPrefillTokens: 850,
      totalUncachedPrefillTokens: 1360,
    },
    now
  );
  const { days } = store.getSeries("spark-a", 8888, { days: 1, now, tzOffsetMin: 0 });
  assert.equal(days[0].decodeTokens, 120);
  assert.equal(days[0].prefillTokens, 210);
  assert.equal(days[0].cachedPrefillTokens, 50);
  assert.equal(days[0].uncachedPrefillTokens, 160);
});

test("LlmDailyStore: a long gap reseeds instead of attributing the jump", () => {
  const store = tmpStore();
  const day1 = new Date("2026-08-16T23:00:00.000Z");
  const day2 = new Date("2026-08-17T01:00:00.000Z");
  const mk = (out, pref) => ({
    available: true,
    generationTps: 10,
    prefillTps: 40,
    totalOutputTokens: out,
    totalPrefillTokens: pref,
  });
  store.record("spark-a", 8888, mk(1000, 2000), day1);
  store.record("spark-a", 8888, mk(1100, 2100), day1);
  store.record("spark-a", 8888, mk(1200, 2200), day2);
  const { days } = store.getSeries("spark-a", 8888, {
    days: 2,
    now: day2,
    tzOffsetMin: 0,
  });
  assert.equal(days[0].date, "2026-08-16");
  assert.equal(days[0].decodeTokens, 100);
  assert.equal(days[1].date, "2026-08-17");
  // A 2h outage between samples must not balloon a single hour bucket.
  assert.equal(days[1].decodeTokens, 0);
});

test("LlmDailyStore: hourly buckets are timezone-sliceable", () => {
  const store = tmpStore();
  const mk = (out) => ({
    available: true,
    generationTps: 10,
    prefillTps: 40,
    totalOutputTokens: out,
    totalPrefillTokens: out * 2,
  });
  // 15:5x UTC = 23:5x on Aug 16 at UTC+8; 16:0x UTC = 00:0x on Aug 17 at UTC+8.
  store.record("spark-a", 8888, mk(1000), new Date("2026-08-16T15:50:00.000Z"));
  store.record("spark-a", 8888, mk(1100), new Date("2026-08-16T15:58:00.000Z"));
  store.record("spark-a", 8888, mk(1300), new Date("2026-08-16T16:06:00.000Z"));

  const now = new Date("2026-08-17T02:00:00.000Z");
  const atUtc = store.getSeries("spark-a", 8888, { days: 2, now, tzOffsetMin: 0 });
  assert.equal(atUtc.days[0].date, "2026-08-16");
  assert.equal(atUtc.days[0].decodeTokens, 300);

  const atPlus8 = store.getSeries("spark-a", 8888, { days: 2, now, tzOffsetMin: 480 });
  assert.equal(atPlus8.days[0].date, "2026-08-16");
  assert.equal(atPlus8.days[0].decodeTokens, 100);
  assert.equal(atPlus8.days[1].date, "2026-08-17");
  assert.equal(atPlus8.days[1].decodeTokens, 200);
});

test("LlmDailyStore: getHourly returns sparse UTC buckets", () => {
  const store = tmpStore();
  store.record(
    "spark-a",
    8888,
    { available: true, generationTps: 5, prefillTps: 9, totalOutputTokens: 10, totalPrefillTokens: 20 },
    new Date("2026-08-16T15:00:00.000Z")
  );
  store.record(
    "spark-a",
    8888,
    { available: true, generationTps: 5, prefillTps: 9, totalOutputTokens: 40, totalPrefillTokens: 80 },
    new Date("2026-08-16T15:05:00.000Z")
  );
  const { hours } = store.getHourly("spark-a", 8888, { days: 0 });
  assert.equal(hours.length, 1);
  assert.equal(hours[0].hour, "2026-08-16T15");
  assert.equal(hours[0].decode, 30);
  assert.equal(hours[0].prefill, 60);
});

test("LlmDailyStore: keeps history older than 30 days and days=0 returns all", () => {
  const store = tmpStore();
  const old = new Date("2026-01-05T12:00:00.000Z");
  const now = new Date("2026-08-16T12:00:00.000Z");
  store.record("spark-a", 8888, { available: true, generationTps: 10, prefillTps: 40 }, old);
  store.record("spark-a", 8888, { available: true, generationTps: 20, prefillTps: 50 }, now);
  const { days } = store.getSeries("spark-a", 8888, { days: 0, now, tzOffsetMin: 0 });
  const jan = days.find((d) => d.date === "2026-01-05");
  assert.ok(jan, "January sample should be retained past the old 30-day cap");
  assert.equal(jan.decodeMax, 10);
  assert.equal(days[days.length - 1].date, "2026-08-16");
});

test("LlmDailyStore: days=0 with no data returns an empty series", () => {
  const store = tmpStore();
  const { days } = store.getSeries("spark-a", 8888, {
    days: 0,
    now: new Date("2026-08-16T12:00:00.000Z"),
  });
  assert.equal(days.length, 0);
});

test("LlmDailyStore: migrates legacy flat history into hourly buckets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-daily-legacy-"));
  const file = path.join(dir, "llm-daily.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      "spark-a:8888": {
        "2026-08-10": {
          decodeMax: 5,
          decodeSum: 5,
          decodeN: 1,
          prefillMax: 0,
          prefillSum: 0,
          prefillN: 0,
          cachedPrefillMax: 0,
          cachedPrefillSum: 0,
          cachedPrefillN: 0,
          uncachedPrefillMax: 0,
          uncachedPrefillSum: 0,
          uncachedPrefillN: 0,
          hasSplit: true,
          decodeTokens: 1000,
          prefillTokens: 2000,
          cachedPrefillTokens: 800,
          uncachedPrefillTokens: 1200,
        },
      },
    })
  );
  const store = new LlmDailyStore(file);
  const now = new Date("2026-08-10T12:00:00.000Z");
  const { days } = store.getSeries("spark-a", 8888, { days: 1, now, tzOffsetMin: 0 });
  assert.equal(days[0].decodeTokens, 1000);
  assert.equal(days[0].prefillTokens, 2000);
  assert.equal(days[0].cachedPrefillTokens, 800);
  assert.equal(days[0].uncachedPrefillTokens, 1200);
  const { hours } = store.getHourly("spark-a", 8888, { days: 0 });
  assert.equal(hours.length, 1);
  assert.equal(hours[0].hour, "2026-08-10T12");
  assert.equal(hours[0].decode, 1000);
});
