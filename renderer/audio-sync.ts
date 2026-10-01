export interface SyncEvent {
  timeMs: number;
  wavId: string;
}

export interface SyncAnchor {
  bmsTimeMs: number;
  osuTimeMs: number;
  lagMs: number;
  score: number;
}

export interface SyncResult {
  mode: "constant" | "affine";
  offsetMs: number;
  scale: number;
  globalScore: number;
  confidence: number;
  residualMs: number;
  anchors: SyncAnchor[];
}

interface SparsePeak {
  frame: number;
  value: number;
}

interface SampleAnalysis {
  peaks: SparsePeak[];
  weight: number;
}

const FEATURE_FRAME_MS = 2;
const GLOBAL_SEARCH_MS = 3000;
const LOCAL_SEARCH_MS = 250;
const LOCAL_WINDOW_MS = 30000;
const LOCAL_STEP_MS = 15000;
const MIN_PEAK_INTERVAL_MS = 20;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = clamp((sorted.length - 1) * p, 0, sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

function monoRmsFrames(buffer: AudioBuffer): number[] {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const frameSize = Math.max(1, Math.round(buffer.sampleRate * FEATURE_FRAME_MS / 1000));
  const frames = Math.ceil(length / frameSize);
  const channelsData = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  const rms = new Array<number>(frames).fill(0);

  for (let f = 0; f < frames; f++) {
    const start = f * frameSize;
    const end = Math.min(length, start + frameSize);
    let sum = 0;
    let count = 0;
    for (let i = start; i < end; i++) {
      let mono = 0;
      for (let c = 0; c < channels; c++) mono += channelsData[c][i];
      mono /= channels;
      sum += mono * mono;
      count++;
    }
    rms[f] = count > 0 ? Math.sqrt(sum / count) : 0;
  }
  return rms;
}

function peakPick(onset: number[]): SparsePeak[] {
  if (onset.length === 0) return [];

  const nonZero = onset.filter(v => v > 0);
  let maxOnset = 0;
  for (const value of onset) maxOnset = Math.max(maxOnset, value);
  if (!Number.isFinite(maxOnset) || maxOnset <= 0) return [];

  const floor = percentile(nonZero, 0.25);
  const threshold = Math.min(
    maxOnset * 0.8,
    Math.max(maxOnset * 0.025, floor * 0.25),
  );
  const minGapFrames = Math.max(1, Math.ceil(MIN_PEAK_INTERVAL_MS / FEATURE_FRAME_MS));

  const candidates: SparsePeak[] = [];
  for (let i = 1; i < onset.length - 1; i++) {
    const v = onset[i];
    if (v < threshold) continue;
    if (v < onset[i - 1] || v < onset[i + 1]) continue;
    candidates.push({ frame: i, value: v });
  }

  // Keep the strongest peak when two onset maxima are almost on top of one another.
  const peaks: SparsePeak[] = [];
  for (const candidate of candidates) {
    const last = peaks[peaks.length - 1];
    if (!last || candidate.frame - last.frame >= minGapFrames) {
      peaks.push(candidate);
    } else if (candidate.value > last.value) {
      peaks[peaks.length - 1] = candidate;
    }
  }
  return peaks;
}

function analyseBuffer(buffer: AudioBuffer): SampleAnalysis {
  const rms = monoRmsFrames(buffer);
  if (rms.length === 0) return { peaks: [], weight: 0 };

  const noiseFloor = percentile(rms, 0.10);
  const onset = new Array<number>(rms.length).fill(0);
  for (let i = 1; i < rms.length; i++) {
    const rise = rms[i] - rms[i - 1];
    const gate = Math.max(noiseFloor * 1.5, 1e-5);
    onset[i] = rms[i] >= gate ? Math.max(0, rise) : 0;
  }

  const peaks = peakPick(onset);
  let maxRms = 0;
  for (const value of rms) maxRms = Math.max(maxRms, value);
  const avgRms = rms.reduce((a, b) => a + b, 0) / rms.length;
  const weight = maxRms < 0.001 && avgRms < 0.0002
    ? 0
    : clamp(Math.sqrt(Math.max(avgRms, 1e-8)) * 5, 0.2, 1);

  if (peaks.length === 0 && maxRms > Math.max(noiseFloor * 4, 0.002)) {
    // A very soft but non-silent sample may not have a clean attack. Still give it
    // one weak reference event at its strongest frame.
    let strongest = 0;
    for (let i = 1; i < rms.length; i++) if (rms[i] > rms[strongest]) strongest = i;
    return {
      peaks: [{ frame: strongest, value: 0.25 }],
      weight,
    };
  }

  return { peaks, weight };
}

function targetEnvelope(buffer: AudioBuffer): { grid: Float32Array; peaks: SparsePeak[] } {
  const rms = monoRmsFrames(buffer);
  const onset = new Array<number>(rms.length).fill(0);
  const floor = percentile(rms, 0.10);
  const gate = Math.max(floor * 1.35, 1e-5);

  for (let i = 1; i < rms.length; i++) {
    const rise = rms[i] - rms[i - 1];
    onset[i] = rms[i] >= gate ? Math.max(0, rise) : 0;
  }

  const peaks = peakPick(onset);
  const grid = new Float32Array(onset.length);
  let max = 1e-9;
  for (const value of onset) max = Math.max(max, value);
  for (let i = 0; i < onset.length; i++) {
    grid[i] = onset[i] / max;
  }
  return { grid, peaks: peaks.map(p => ({ frame: p.frame, value: p.value / max })) };
}

function buildReferenceGrid(
  events: SyncEvent[],
  analyses: Map<string, SampleAnalysis>,
  lengthFrames: number,
): Float32Array {
  const grid = new Float32Array(lengthFrames);
  for (const event of events) {
    const analysis = analyses.get(event.wavId);
    if (!analysis || analysis.peaks.length === 0 || analysis.weight <= 0) continue;

    const startFrame = Math.round(event.timeMs / FEATURE_FRAME_MS);
    for (const peak of analysis.peaks) {
      const frame = startFrame + peak.frame;
      if (frame < 0 || frame >= lengthFrames) continue;
      grid[frame] += peak.value * analysis.weight;
    }
  }

  let max = 0;
  for (const value of grid) max = Math.max(max, value);
  if (max > 0) {
    for (let i = 0; i < grid.length; i++) grid[i] = Math.min(1, grid[i] / max);
  }
  return grid;
}

function sparseFromGrid(grid: Float32Array, threshold = 0.035): SparsePeak[] {
  const peaks: SparsePeak[] = [];
  for (let i = 1; i < grid.length - 1; i++) {
    const v = grid[i];
    if (v < threshold || v < grid[i - 1] || v < grid[i + 1]) continue;
    peaks.push({ frame: i, value: v });
  }
  return peaks;
}

function cosineLagScore(
  reference: SparsePeak[],
  target: Float32Array,
  lagFrames: number,
  minFrame = 0,
  maxFrame = Number.POSITIVE_INFINITY,
): number {
  let dot = 0;
  let refEnergy = 0;
  let targetEnergy = 0;
  let matched = 0;

  for (const p of reference) {
    if (p.frame < minFrame || p.frame > maxFrame) continue;
    const j = p.frame + lagFrames;
    if (j < 0 || j >= target.length) continue;
    const t = target[j];
    dot += p.value * t;
    refEnergy += p.value * p.value;
    targetEnergy += t * t;
    if (t > 0.05) matched++;
  }

  if (refEnergy <= 0 || targetEnergy <= 0 || matched === 0) return 0;
  return dot / Math.sqrt(refEnergy * targetEnergy);
}

function searchLag(
  reference: SparsePeak[],
  target: Float32Array,
  minLagMs: number,
  maxLagMs: number,
  minFrame = 0,
  maxFrame = Number.POSITIVE_INFINITY,
): { lagMs: number; score: number } {
  const start = Math.ceil(minLagMs / FEATURE_FRAME_MS);
  const end = Math.floor(maxLagMs / FEATURE_FRAME_MS);
  let bestLag = 0;
  let bestScore = -1;

  for (let lag = start; lag <= end; lag++) {
    const score = cosineLagScore(reference, target, lag, minFrame, maxFrame);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  return { lagMs: bestLag * FEATURE_FRAME_MS, score: Math.max(0, bestScore) };
}

function refineLagMs(
  reference: SparsePeak[],
  target: Float32Array,
  coarseLagMs: number,
): { lagMs: number; score: number } {
  const coarseFrame = Math.round(coarseLagMs / FEATURE_FRAME_MS);
  let bestLagFrame = coarseFrame;
  let bestScore = cosineLagScore(reference, target, coarseFrame);

  // The dense target grid is still 10 ms. Refine the selected lag with a small
  // sub-frame interpolation from the three neighboring correlation scores.
  const left = cosineLagScore(reference, target, coarseFrame - 1);
  const right = cosineLagScore(reference, target, coarseFrame + 1);
  const denom = left - 2 * bestScore + right;
  let frac = 0;
  if (Math.abs(denom) > 1e-9) frac = clamp(0.5 * (left - right) / denom, -0.5, 0.5);

  return { lagMs: (bestLagFrame + frac) * FEATURE_FRAME_MS, score: Math.max(bestScore, left, right) };
}

function weightedAffineFit(anchors: SyncAnchor[]): { scale: number; offsetMs: number; residualMs: number } {
  if (anchors.length < 2) return { scale: 1, offsetMs: anchors[0]?.lagMs ?? 0, residualMs: 0 };

  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const a of anchors) {
    const w = Math.max(0.05, a.score);
    const x = a.bmsTimeMs;
    const y = a.osuTimeMs;
    sw += w;
    sx += w * x;
    sy += w * y;
    sxx += w * x * x;
    sxy += w * x * y;
  }

  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return { scale: 1, offsetMs: sy / sw - sx / sw, residualMs: 0 };

  const scale = clamp((sw * sxy - sx * sy) / denom, 0.997, 1.003);
  const offsetMs = (sy - scale * sx) / sw;

  let error = 0;
  for (const a of anchors) {
    const w = Math.max(0.05, a.score);
    const residual = (scale * a.bmsTimeMs + offsetMs) - a.osuTimeMs;
    error += w * residual * residual;
  }
  return { scale, offsetMs, residualMs: Math.sqrt(error / sw) };
}

export function synchronizeBmsToOsu(
  events: SyncEvent[],
  buffers: Map<string, AudioBuffer>,
  targetAudio: AudioBuffer,
): SyncResult {
  if (events.length === 0 || targetAudio.length === 0) {
    throw new Error("No usable audio events were available for synchronization");
  }

  const analyses = new Map<string, SampleAnalysis>();
  for (const [id, buffer] of buffers) {
    analyses.set(id, analyseBuffer(buffer));
  }

  let lastEventMs = 0;
  for (const event of events) lastEventMs = Math.max(lastEventMs, event.timeMs);
  let lastSampleMs = 0;
  for (const buffer of buffers.values()) lastSampleMs = Math.max(lastSampleMs, buffer.duration * 1000);
  const referenceLengthMs = Math.max(lastEventMs + Math.min(lastSampleMs, 2000), 0);
  const referenceFrames = Math.ceil(referenceLengthMs / FEATURE_FRAME_MS) + 1;

  const referenceGrid = buildReferenceGrid(events, analyses, referenceFrames);
  const referencePeaks = sparseFromGrid(referenceGrid);
  if (referencePeaks.length < 4) {
    throw new Error("Not enough audible BMS events were found to synchronize the audio");
  }

  const target = targetEnvelope(targetAudio).grid;
  const coarse = searchLag(
    referencePeaks,
    target,
    -GLOBAL_SEARCH_MS,
    GLOBAL_SEARCH_MS,
  );
  const refined = refineLagMs(referencePeaks, target, coarse.lagMs);

  const globalOffset = refined.lagMs;
  const anchors: SyncAnchor[] = [];
  const songEnd = Math.min(lastEventMs, targetAudio.duration * 1000);

  for (let start = 0; start < songEnd; start += LOCAL_STEP_MS) {
    const end = Math.min(songEnd, start + LOCAL_WINDOW_MS);
    if (end - start < 5000) continue;

    const minFrame = Math.floor(start / FEATURE_FRAME_MS);
    const maxFrame = Math.ceil(end / FEATURE_FRAME_MS);
    const local = searchLag(
      referencePeaks,
      target,
      globalOffset - LOCAL_SEARCH_MS,
      globalOffset + LOCAL_SEARCH_MS,
      minFrame,
      maxFrame,
    );
    if (local.score < Math.max(0.08, refined.score * 0.25)) continue;

    const localRef = referencePeaks.filter(p => p.frame >= minFrame && p.frame <= maxFrame);
    const fine = refineLagMs(localRef, target, local.lagMs);
    const center = (start + end) * 0.5;
    anchors.push({
      bmsTimeMs: center,
      osuTimeMs: center + fine.lagMs,
      lagMs: fine.lagMs,
      score: fine.score,
    });
  }

  let scale = 1;
  let offsetMs = globalOffset;
  let residualMs = 0;
  let mode: "constant" | "affine" = "constant";

  if (anchors.length >= 3) {
    const fit = weightedAffineFit(anchors);
    const constantResidual = Math.sqrt(
      anchors.reduce((sum, a) => sum + Math.max(0.05, a.score) * Math.pow(a.lagMs - globalOffset, 2), 0) /
      anchors.reduce((sum, a) => sum + Math.max(0.05, a.score), 0)
    );

    const totalDrift = Math.abs((fit.scale - 1) * songEnd);
    if (totalDrift >= 5 && fit.residualMs + 1 < constantResidual && fit.residualMs <= 25) {
      mode = "affine";
      scale = fit.scale;
      offsetMs = fit.offsetMs;
      residualMs = fit.residualMs;
    } else {
      residualMs = constantResidual;
    }
  }

  const confidence = clamp(
    refined.score * (0.65 + 0.35 * clamp(anchors.length / Math.max(3, Math.floor(songEnd / LOCAL_STEP_MS)), 0, 1)),
    0,
    1,
  );

  return {
    mode,
    offsetMs,
    scale,
    globalScore: refined.score,
    confidence,
    residualMs,
    anchors,
  };
}

export function mapBmsTime(timeMs: number, sync: SyncResult): number {
  return timeMs * sync.scale + sync.offsetMs;
}
