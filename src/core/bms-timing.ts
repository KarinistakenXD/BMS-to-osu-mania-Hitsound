/**
 * src/core/bms-timing.ts
 * Absolute millisecond integration and note scheduling.
 */

import type { 
  Rational, 
  TimingEngine, 
  TimingMap, 
  NoteScheduler, 
  ScheduledNote 
} from "./bms-osu-core";
import type { ResolvedBms, TimePoint, StopEvent } from "./bms-parser";
import { comparePoint } from "./bms-parser";

function float(r: Rational): number {
  return r.den === 0 ? 0 : r.num / r.den;
}

interface ControlPoint {
  measure: number;
  frac: number;
  ms: number;
  bpm: number;
}

interface ProcessedStop {
  measure: number;
  position: Rational;
  durationMs: number;
}

class TimingMapImpl implements TimingMap {
  constructor(
    private readonly controlPoints: ControlPoint[],
    private readonly stops: ProcessedStop[],
    private readonly measureLengths: Map<number, number>
  ) {}

  toMs(measure: number, position: Rational): number {
    const m = Number(measure);
    const frac = float(position);
    
    // Find the closest preceding control point
    let cp = this.controlPoints[0];
    for (let i = this.controlPoints.length - 1; i >= 0; i--) {
      const p = this.controlPoints[i];
      if (p.measure < m || (p.measure === m && p.frac <= frac)) {
        cp = p;
        break;
      }
    }

    const fracDiff = frac - cp.frac;
    const lengthMult = this.measureLengths.get(m) ?? 1.0;
    const beatMs = 240000 / cp.bpm;
    let absoluteMs = cp.ms + (fracDiff * lengthMult * beatMs);

    const targetPoint: TimePoint = { measure: m, position };
    for (const stop of this.stops) {
      if (comparePoint(stop, targetPoint) < 0) {
        absoluteMs += stop.durationMs;
      }
    }

    return absoluteMs;
  }
}

export class BmsTimingEngine implements TimingEngine {
  build(bms: ResolvedBms): TimingMap {
    let maxMeasure = 0;
    for (const b of bms.bpmChanges) { if (Number(b.measure) > maxMeasure) maxMeasure = Number(b.measure); }
    for (const s of bms.stops) { if (Number(s.measure) > maxMeasure) maxMeasure = Number(s.measure); }
    for (const n of bms.notes) { if (Number(n.measure) > maxMeasure) maxMeasure = Number(n.measure); }

    const bpmChanges = [...bms.bpmChanges].map(b => ({
      measure: Number(b.measure),
      frac: float(b.position),
      bpm: b.bpm
    })).sort((a, b) => a.measure - b.measure || a.frac - b.frac);

    const controlPoints: ControlPoint[] = [];
    let currentBpm = bms.header.bpm || 120;
    let currentMs = 0;
    let bpmIdx = 0;

    // Sequentially build the absolute milliseconds for every single measure
    for (let m = 0; m <= maxMeasure; m++) {
      const mult = bms.measureLengths.get(m) ?? 1.0;
      let lastFrac = 0.0;

      while (bpmIdx < bpmChanges.length && bpmChanges[bpmIdx].measure === m) {
        const change = bpmChanges[bpmIdx];
        if (change.frac > lastFrac) {
          currentMs += (change.frac - lastFrac) * mult * (240000 / currentBpm);
          lastFrac = change.frac;
        }
        currentBpm = change.bpm;
        controlPoints.push({ measure: m, frac: change.frac, ms: currentMs, bpm: currentBpm });
        bpmIdx++;
      }

      if (lastFrac < 1.0) {
        currentMs += (1.0 - lastFrac) * mult * (240000 / currentBpm);
      }

      // Anchor the start of the NEXT measure so intermediate lookups never fail
      controlPoints.push({ measure: m + 1, frac: 0.0, ms: currentMs, bpm: currentBpm });
    }

    if (controlPoints.length === 0 || controlPoints[0].measure !== 0 || controlPoints[0].frac !== 0) {
      controlPoints.unshift({ measure: 0, frac: 0.0, ms: 0, bpm: bms.header.bpm || 120 });
    }

    const processedStops: ProcessedStop[] = [];
    for (const s of bms.stops) {
      const m = Number(s.measure);
      const frac = float(s.position);
      let activeBpm = bms.header.bpm || 120;

      for (let i = controlPoints.length - 1; i >= 0; i--) {
        if (controlPoints[i].measure < m || (controlPoints[i].measure === m && controlPoints[i].frac <= frac)) {
          activeBpm = controlPoints[i].bpm;
          break;
        }
      }
      processedStops.push({
        measure: m,
        position: s.position,
        durationMs: (s.ticks192 / 192) * (240000 / activeBpm)
      });
    }

    return new TimingMapImpl(controlPoints, processedStops, bms.measureLengths);
  }
}

export class BmsNoteScheduler implements NoteScheduler {
  schedule(bms: ResolvedBms, timing: TimingMap): ScheduledNote[] {
    const notes: ScheduledNote[] = [];

    for (const n of bms.notes) {
      const timeMs = timing.toMs(Number(n.measure), n.position);
      const audio = bms.audio.get(n.value);

      if (audio && (audio.status === "exact" || audio.status === "case-insensitive" || audio.status === "extension-swap")) {
        notes.push({
          timeMs,
          wavId: n.value,
          filename: audio.resolved!,
          channel: n.channel,
          isBgm: n.kind === "bgm" || n.kind === "invisible",
        });
      }
    }

    notes.sort((a, b) => a.timeMs - b.timeMs || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));
    return notes;
  }
}
