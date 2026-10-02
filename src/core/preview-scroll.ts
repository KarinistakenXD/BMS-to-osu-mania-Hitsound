import type { ResolvedBms } from "./bms-parser";
import type { TimingMap } from "./bms-osu-core";

export interface ScrollPoint { timeMs: number; multiplier: number; }

// Preview positions only. Audio, synchronization, and export use original times.
export function bmsScrollPoints(chart: ResolvedBms, timing: TimingMap): ScrollPoint[] {
  const baseBpm = chart.header.bpm || 120;
  const controls = [
    ...chart.bpmChanges.map(p => ({ timeMs: timing.toMs(p.measure, p.position), bpm: p.bpm, scroll: undefined as number | undefined })),
    ...chart.scrollChanges.map(p => ({ timeMs: timing.toMs(p.measure, p.position), bpm: undefined as number | undefined, scroll: p.multiplier })),
  ].sort((a, b) => a.timeMs - b.timeMs);
  const points: ScrollPoint[] = [{ timeMs: 0, multiplier: 1 }];
  let bpm = baseBpm, scroll = 1;
  for (const c of controls) {
    bpm = c.bpm ?? bpm; scroll = c.scroll ?? scroll;
    points.push({ timeMs: c.timeMs, multiplier: bpm / baseBpm * scroll });
  }
  const stops = new Map<number, number>();
  for (const stop of chart.stops) {
    const timeMs = timing.toMs(stop.measure, stop.position);
    let activeBpm = baseBpm;
    for (const c of controls) if (c.timeMs <= timeMs && c.bpm !== undefined) activeBpm = c.bpm;
    stops.set(timeMs, (stops.get(timeMs) ?? 0) + stop.ticks192 / 192 * 240000 / activeBpm);
  }
  const movingPoints = [...points];
  for (const [timeMs, duration] of stops) {
    if (duration <= 0) continue;
    let multiplier = 1;
    for (const p of movingPoints) if (p.timeMs <= timeMs) multiplier = p.multiplier;
    points.push({ timeMs, multiplier: 0 }, { timeMs: timeMs + duration, multiplier });
  }
  return points.sort((a, b) => a.timeMs - b.timeMs);
}

export function osuScrollPoints(rows: string[][], lastObjectTimeMs?: number): ScrollPoint[] {
  const points: ScrollPoint[] = [];
  const sorted = rows.filter(r => Number.isFinite(Number(r[0])) && Number.isFinite(Number(r[1])))
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  const red = sorted.filter(r => (r[6] ?? "1") === "1" && Number(r[1]) > 0);
  const end = lastObjectTimeMs ?? Number(red.at(-1)?.[0] ?? 0);
  const durations = new Map<number, number>();
  // Match osu!mania's duration-weighted most-common beat length, not the intro BPM.
  // Reference: ppy/osu Beatmap.GetMostCommonBeatLength() and DrawableManiaRuleset.
  for (let i = 0; i < red.length; i++) {
    const time = Number(red[i][0]), beat = Math.round(Number(red[i][1]) * 1000) / 1000;
    if (time > end) continue;
    const from = i === 0 ? 0 : time;
    const until = Math.min(end, Number(red[i + 1]?.[0] ?? end));
    durations.set(beat, (durations.get(beat) ?? 0) + Math.max(0, until - from));
  }
  let baseBeat = [...durations].sort((a, b) => b[1] - a[1])[0]?.[0] || 500;
  if (red.length) {
    const values = red.map(r => Number(r[1]));
    baseBeat = Math.max(values.reduce((a,b)=>Math.min(a,b), Infinity), Math.min(values.reduce((a,b)=>Math.max(a,b), -Infinity), baseBeat));
  }
  let beat = baseBeat;
  for (const r of sorted) {
    const value = Number(r[1]);
    if ((r[6] ?? "1") === "1" && value > 0) {
      beat = value;
      points.push({ timeMs: Number(r[0]), multiplier: baseBeat / beat });
    } else if ((r[6] ?? "1") === "0") {
      points.push({ timeMs: Number(r[0]), multiplier: baseBeat / beat * (value < 0 ? Math.max(.1, Math.min(10, -100 / value)) : 1) });
    }
  }
  return points;
}
