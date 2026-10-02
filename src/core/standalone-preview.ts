import * as path from "node:path";
import { BmsFileParser } from "./bms-parser";
import { BmsTimingEngine } from "./bms-timing";
import { NodeFileSource } from "./node-io";
import { readOsuPreview } from "./osu-preview";
import { bmsScrollPoints } from "./preview-scroll";

export async function readStandaloneChart(filePath: string, kind: "bms" | "osu") {
  if (kind === "osu") {
    const chart = await readOsuPreview(filePath, "");
    if (chart.osuPreview.mode !== 3) throw new Error("Single-file note preview currently supports osu!mania maps (Mode 3).");
    return { kind, keys: chart.osuPreview.keys, notes: chart.osuPreview.notes,
      events: [], files: {} as Record<string, string>, timingPoints: chart.timingPoints,
      beatTimes: [] as number[], audioPath: chart.osuAudioPath, title: chart.metadata.title,
      warnings: [] as string[], scrollPoints: chart.scrollPoints };
  }
  const chart = await new BmsFileParser().parse(new NodeFileSource(), filePath);
  const timing = new BmsTimingEngine().build(chart);
  const pms = path.extname(filePath).toLowerCase() === ".pms";
  const visible = chart.notes.filter(n => n.kind === "tap" || n.kind === "ln");
  const sideKeys = visible.some(n => /^[1256][89]$/.test(n.channel)) ? 8 : 6;
  const hasDP = visible.some(n => n.channel[0] === "2" || n.channel[0] === "6");
  const laneFor = (channel: string): number => {
    const c = Number(channel.slice(1));
    if (pms) return channel[0] === "1" || channel[0] === "5" ? c - 1 : c + 3;
    const key = c === 6 ? 0 : c <= 5 ? c : c === 8 ? 6 : c === 9 ? 7 : -1;
    return key < 0 ? -1 : key + (channel[0] === "2" || channel[0] === "6" ? sideKeys : 0);
  };
  const notes = visible.map(n => ({ timeMs: timing.toMs(n.measure, n.position),
    endTimeMs: n.end ? timing.toMs(n.end.measure, n.end.position) : timing.toMs(n.measure, n.position),
    lane: laneFor(n.channel) })).filter(n => n.lane >= 0).sort((a, b) => a.timeMs - b.timeMs);
  const keys = pms ? 9 : sideKeys * (hasDP ? 2 : 1);
  const files: Record<string, string> = {};
  const usedIds = new Set(chart.notes.map(n => n.value));
  for (const [id, audio] of chart.audio) if (usedIds.has(id) && audio.resolved && audio.status !== "missing") files[id] = path.resolve(path.dirname(filePath), audio.resolved);
  const events = chart.notes.filter(n => !!files[n.value]).map(n => ({ wavId: n.value,
    timeMs: timing.toMs(n.measure, n.position), lane: 0, isBgm: n.kind === "bgm" || n.kind === "invisible" })).sort((a, b) => a.timeMs - b.timeMs);
  const lastMeasure = chart.notes.reduce((m, n) => Math.max(m, n.end?.measure ?? n.measure), 0);
  const beatTimes: number[] = [];
  const viewGrids: Record<string, { timeMs: number; beat: boolean }[]> = {};
  for (const division of [1, 2, 3, 4, 6, 8, 12, 16]) viewGrids[division] = [];
  for (let measure = 0; measure <= lastMeasure + 1; measure++) {
    const beats = 4 * (chart.measureLengths.get(measure) ?? 1);
    for (let beat = 0; beat < beats; beat++) {
      beatTimes.push(timing.toMs(measure, { num: Math.round(beat / beats * 1000000), den: 1000000 }));
      for (const division of [1, 2, 3, 4, 6, 8, 12, 16]) for (let n = 0; n < division && beat + n / division < beats; n++)
        viewGrids[division].push({ timeMs: timing.toMs(measure, { num: Math.round((beat + n / division) / beats * 1000000), den: 1000000 }), beat: n === 0 });
    }
  }
  return { kind, keys, notes, events, files, timingPoints: [], beatTimes,
    viewGrids, scrollPoints: bmsScrollPoints(chart, timing), audioPath: null, title: chart.header.title ?? path.basename(filePath), warnings: chart.warnings };
}
