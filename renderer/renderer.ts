/// <reference path="./bms2osu.d.ts" />

import { analyseBuffer, mapBmsTime, synchronizeBmsToOsu, type SampleAnalysis, type SyncResult } from "./audio-sync";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const logEl = $<HTMLDivElement>("log");
const appendLog = (line: string) => {
  logEl.textContent += line.split(/\r?\n/).map(row => /^\[[^\]]+\]/.test(row) ? row : "[INFO] " + row).join("\n") + "\n";
  logEl.scrollTop = logEl.scrollHeight;
};
window.bms2osu.onLog(appendLog);

interface Note {
  timeMs: number;
  wavId: string;
  lane: number;
  isBgm: boolean;
  sourceTimeMs?: number;
  measure?: number;
  positionNum?: number;
  positionDen?: number;
  measureLength?: number;
}
interface TimingPoint { timeMs: number; beatLength: number; meter: number; }
interface TargetPreviewNote { timeMs: number; endTimeMs: number; lane: number; }
interface PlacedPreviewNote extends TargetPreviewNote { wavId: string; wavIds: string[]; isBgm: boolean; compositeKey?: string; }
interface MetronomeTick { timeMs: number; accent: boolean; beat: number; meter: number; }

type PreviewMode = "target-plus-keys" | "target-only" | "bms-reference" | "keys-only";
type MetronomeSource = "osu" | "bms";
type NotePreviewMode = "converted" | "target" | "overlay";
type ResnapMode = "fast" | "thorough";

const state = {
  standaloneKind: null as "bms" | "osu" | null,
  nativeViewGrids: {} as Record<string, { timeMs: number; beat: boolean }[]>,
  analyzedReuseKey: "",
  bmsPath: "",
  osuPath: "",
  referenceEvents: [] as Note[],
  syncedEvents: [] as Note[],
  files: {} as Record<string, string>,
  audioBuffers: new Map<string, SampleAnalysis>(),
  targetAudioBuffer: null as AudioBuffer | null,
  sync: null as SyncResult | null,
  timingPoints: [] as TimingPoint[],
  scrollPoints: [] as { timeMs: number; multiplier: number }[],
  bmsBeatTimes: [] as number[],
  syncedBmsBeatTimes: [] as number[],
  phaseBeatLocks: [] as Array<{ targetIndex: number; targetMs: number; distanceMs: number } | null>,
  targetNotes: [] as TargetPreviewNote[],
  targetAnchorTimes: [] as number[],
  targetKeys: 4,
  targetMode: 0,
  songLengthMs: 0,
  metadata: { bms: { title: "", artist: "" }, osu: { title: "", artist: "", creator: "", version: "" } },
  compatibilityOk: false,
  stretchedTargetBuffers: new Map<number, AudioBuffer>(),
  stretchedSampleBuffers: new Map<string, AudioBuffer>(),
  convertedMixBuffer: null as AudioBuffer | null,
  referenceMixBuffer: null as AudioBuffer | null,
  tempoMixBuffers: new Map<string, AudioBuffer>(),
  requiredKeys: 1,
};

const btnBms = $<HTMLButtonElement>("btn-pick-bms");
const btnOsu = $<HTMLButtonElement>("btn-pick-osu");
const btnLoad = $<HTMLButtonElement>("btn-load");
const btnPlay = $<HTMLButtonElement>("btn-play");
const btnConvert = $<HTMLButtonElement>("btn-convert");
const timeline = $<HTMLInputElement>("timeline");
const timeCurrent = $<HTMLSpanElement>("time-current");
const timeTotal = $<HTMLSpanElement>("time-total");
const resnap = $<HTMLInputElement>("resnap");
const snapTolerance = $<HTMLInputElement>("snap-tolerance");
const resnapMode = $<HTMLSelectElement>("resnap-mode");
const statusEl = $<HTMLDivElement>("sync-status");
const canvas = $<HTMLCanvasElement>("waveform");
const waveWrap = $<HTMLDivElement>("wave-wrap");
const playhead = $<HTMLDivElement>("playhead");
const noteCanvas = $<HTMLCanvasElement>("note-preview");
const notePreviewMode = $<HTMLSelectElement>("note-preview-mode");
const notePreviewSpeed = $<HTMLInputElement>("note-preview-speed");
const notePreviewSpeedOut = $<HTMLOutputElement>("note-preview-speed-out");
const notePreviewInfo = $<HTMLDivElement>("note-preview-info");
const keysInput = $<HTMLInputElement>("keys");
const previewMode = $<HTMLSelectElement>("preview-mode");
const metronomeEnabled = $<HTMLInputElement>("metronome-enabled");
const metronomeSource = $<HTMLSelectElement>("metronome-source");
const metronomeModel = $<HTMLDivElement>("metronome-model");
const metronomeStick = $<HTMLDivElement>("metronome-stick");
const metronomeBpm = $<HTMLElement>("metronome-bpm");
const metronomeBeatLabel = $<HTMLSpanElement>("metronome-beat-label");
const metronomeBeatBar = $<HTMLDivElement>("metronome-beat-bar");
const brandOrb = $<HTMLButtonElement>("brand-orb");
const snowLayer = $<HTMLDivElement>("bms-snow-layer");
const fileSummaryBms = $<HTMLDivElement>("file-summary-bms");
const fileSummaryOsu = $<HTMLDivElement>("file-summary-osu");
const keyVisualizer = $<HTMLDivElement>("key-visualizer");
const hitsoundVolume = $<HTMLInputElement>("hitsound-volume");
const hitsoundVolumeOut = $<HTMLOutputElement>("hitsound-volume-out");
const audioVolume = $<HTMLInputElement>("audio-volume");
const audioVolumeOut = $<HTMLOutputElement>("audio-volume-out");
const playbackRate = $<HTMLSelectElement>("playback-rate");
const sampleFormat = $<HTMLSelectElement>("sample-format");
const oggQuality = $<HTMLInputElement>("ogg-quality");
const oggQualityOut = $<HTMLOutputElement>("ogg-quality-out");
const conflictPolicy = $<HTMLSelectElement>("sample-conflict");
const ffmpegStatus = $<HTMLDivElement>("ffmpeg-status");
const oggOptions = $<HTMLDivElement>("ogg-options");

function invalidateSelectedPair(message = "Selection changed — analyze this BMS / osu pair before previewing or converting."): void {
  if (state.standaloneKind) { previewMode.value = "target-plus-keys"; notePreviewMode.value = "converted"; metronomeSource.value = "osu"; }
  state.standaloneKind = null;
  setStandaloneControls(false);
  state.analyzedReuseKey = "";
  stopPreview();
  state.sync = null;
  state.compatibilityOk = false;
  state.syncedEvents = [];
  state.syncedBmsBeatTimes = [];
  state.nativeViewGrids = {};
  state.phaseBeatLocks = [];
  state.targetNotes = [];
  state.targetAnchorTimes = [];
  state.targetAudioBuffer = null;
  state.audioBuffers.clear();
  state.stretchedTargetBuffers.clear();
  state.stretchedSampleBuffers.clear();
  state.convertedMixBuffer = null;
  state.referenceMixBuffer = null;
  state.tempoMixBuffers.clear();
  state.requiredKeys = 1;
  state.songLengthMs = 0;
  invalidatePreviewAudio();
  timeline.value = "0";
  timeline.disabled = true;
  timeCurrent.textContent = "0:00";
  timeTotal.textContent = "0:00";
  btnPlay.disabled = true;
  btnConvert.disabled = true;
  statusEl.textContent = message;
  drawWaveform();
  drawNotePreview();
}

type ChartFolder = { folder: string; charts: { path: string; label: string; keys: number }[]; warnings: string[]; defaultPath?: string };
const chartFolders: Record<"bms" | "osu", ChartFolder | null> = { bms: null, osu: null };
let chartSelectionBusy = false;
let difficultySelectionRequest = 0;
function refreshChartSelectors(): void {
  for (const kind of ["bms", "osu"] as const) {
    $<HTMLSelectElement>("difficulty-" + kind).disabled = chartSelectionBusy || !chartFolders[kind]?.charts.length;
  }
}
async function chooseDifficulty(kind: "bms" | "osu", file: string): Promise<void> {
  if (chartSelectionBusy || !chartFolders[kind]?.charts.some(c => c.path === file)) return;
  if ((kind === "bms" ? state.bmsPath : state.osuPath) === file) return;
  const request = ++difficultySelectionRequest;
  const reloadSingle = !!state.standaloneKind;
  if (kind === "osu" && state.bmsPath && await reuseAnalyzedTarget(file, () => request === difficultySelectionRequest && !chartSelectionBusy)) return;
  if (request !== difficultySelectionRequest || chartSelectionBusy) return;
  if (kind === "bms") state.bmsPath = file; else state.osuPath = file;
  $("path-" + kind).textContent = file;
  (kind === "bms" ? fileSummaryBms : fileSummaryOsu).textContent = file.split(/[\\/]/).pop() || file;
  invalidateSelectedPair("Difficulty changed. Choose Note preview, or analyze the selected pair."); checkReady();
  if (reloadSingle && !(state.bmsPath && state.osuPath)) await loadStandalonePreview();
}
for (const kind of ["bms", "osu"] as const) {
  const button = kind === "bms" ? btnBms : btnOsu;
  const select = $<HTMLSelectElement>("difficulty-" + kind);
  select.onchange = () => { void chooseDifficulty(kind, select.value); };
  button.onclick = async () => {
    if (chartSelectionBusy) return;
    chartSelectionBusy = true; btnBms.disabled = true; btnOsu.disabled = true; refreshChartSelectors();
    let folder: ChartFolder | null = null;
    try { folder = await window.bms2osu.selectChartFolder(kind); }
    catch (error) { appendLog("[ERROR] Folder selection: " + String(error)); }
    finally { chartSelectionBusy = false; btnBms.disabled = false; btnOsu.disabled = false; refreshChartSelectors(); }
    if (!folder?.charts.length) return;
    chartFolders[kind] = folder; select.replaceChildren();
    for (const chart of folder.charts) { const option = document.createElement("option");
      option.value = chart.path; option.textContent = chart.label; option.title = chart.path; select.append(option); }
    select.value = folder.defaultPath || folder.charts[0].path; refreshChartSelectors();
    await chooseDifficulty(kind, select.value);
  };
}

async function reuseAnalyzedTarget(osuPath: string, selectionCurrent: () => boolean = () => true): Promise<boolean> {
  if (!state.compatibilityOk || !state.sync || !state.targetAudioBuffer || !state.analyzedReuseKey) return false;
  const bmsPath = state.bmsPath;
  const generation = preparationGeneration;
  const target = await window.bms2osu.readOsuPreview(osuPath, bmsPath) as {
    reuseKey: string;
    timingPoints: TimingPoint[];
    scrollPoints?: { timeMs: number; multiplier: number }[];
    metadata: typeof state.metadata.osu;
    osuPreview: { mode: number; keys: number; notes: TargetPreviewNote[] };
  } | null;
  if (!selectionCurrent() || !target?.reuseKey || target.reuseKey !== state.analyzedReuseKey ||
      generation !== preparationGeneration || bmsPath !== state.bmsPath || !state.targetAudioBuffer) return false;

  state.osuPath = osuPath;
  state.metadata.osu = target.metadata;
  state.timingPoints = target.timingPoints;
  state.scrollPoints = target.scrollPoints ?? [];
  state.targetMode = target.osuPreview.mode;
  state.targetKeys = target.osuPreview.keys;
  state.targetNotes = target.osuPreview.notes;
  // A compatible difficulty switch changes the displayed notes, not the
  // analyzed resnap anchors, audio duration or prepared transport buffers.
  // Analyze explicitly replaces that timing reference for preview and export.
  $<HTMLDivElement>("path-osu").textContent = osuPath;
  fileSummaryOsu.textContent = `${osuPath.split(/[\\/]/).pop() || osuPath} · ${state.targetKeys}K · ${state.targetNotes.length} objects`;
  timeline.max = String(state.songLengthMs / 1000);
  timeTotal.textContent = formatTime(state.songLengthMs / 1000);
  setPosition(Number(timeline.value));
  btnConvert.disabled = false;
  checkReady();
  statusEl.textContent = "Reused the recent audio analysis: artist, title, timing and audio match.";
  appendLog("Difficulty notes updated; analyzed timing reference and prepared audio retained.");
  void warmPreview();
  return true;
}
const checkReady = () => {
  btnLoad.disabled = !(state.bmsPath || state.osuPath);
  btnLoad.textContent = state.bmsPath && state.osuPath ? "Analyze & synchronize" : "Note preview";
  setStandaloneControls(!!(state.bmsPath || state.osuPath) && !(state.bmsPath && state.osuPath));
};
const formatTime = (sec: number) => `${Math.floor(Math.max(0, sec) / 60)}:${Math.floor(Math.max(0, sec) % 60).toString().padStart(2, "0")}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const previewLoading = $<HTMLDivElement>("preview-loading");
const previewLoadingMessage = $<HTMLSpanElement>("preview-loading-message");
const previewLoadingTitle = $<HTMLElement>("preview-loading-title");
const previewLoadingSpinner = $<HTMLElement>("preview-loading-spinner");
let previewLoadingKey: string | null = null;
function showPreviewLoading(key: string, message: string): void {
  previewLoadingKey = key;
  previewLoading.hidden = false;
  previewLoadingSpinner.hidden = false;
  previewLoadingTitle.textContent = "Preparing preview";
  previewLoadingMessage.textContent = message;
  noteCanvas.setAttribute("aria-busy", "true");
}
function finishPreviewLoading(key: string, ready: boolean): void {
  if (previewLoadingKey !== key) return;
  if (ready) {
    previewLoading.hidden = true; previewLoadingKey = null;
    noteCanvas.setAttribute("aria-busy", "false");
  } else {
    previewLoadingSpinner.hidden = true;
    previewLoadingTitle.textContent = "Preview could not be prepared";
    previewLoadingMessage.textContent = "See Activity and retry Preview.";
    noteCanvas.setAttribute("aria-busy", "false");
  }
}

let audioCtx: AudioContext | null = null;
const bytesToArrayBuffer = (bytes: Uint8Array) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const describeSync = (s: SyncResult) => `Audio sync: ${s.method ?? "onset"} / ${s.mode}${s.mode === "affine" ? ` scale ${s.scale.toFixed(8)}` : ""}, offset ${s.offsetMs >= 0 ? "+" : ""}${s.offsetMs.toFixed(2)} ms, confidence ${s.confidence.toFixed(3)}, residual ${s.residualMs.toFixed(2)} ms`;

function normalizeIdentity(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/feat\.?|featuring|ft\.?/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function tokenSimilarity(a: string, b: string): number {
  const aa = new Set(normalizeIdentity(a));
  const bb = new Set(normalizeIdentity(b));
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const token of aa) if (bb.has(token)) common++;
  return common / Math.max(aa.size, bb.size);
}

type PairCompatibilityLevel = "pass" | "warning" | "fail";

interface PairCompatibilityResult {
  level: PairCompatibilityLevel;
  ok: boolean;
  summary: string;
  reasons: string[];
  metrics: string[];
}

function assessPairCompatibility(sync: SyncResult): PairCompatibilityResult {
  const hardReasons: string[] = [];
  const warnings: string[] = [];

  const phaseLocked = state.phaseBeatLocks.filter(Boolean).length;
  const phaseRatio = state.phaseBeatLocks.length ? phaseLocked / state.phaseBeatLocks.length : 0;
  const targetDuration = Math.max(1, (state.targetAudioBuffer?.duration ?? 0) * 1000);
  const lastMapped = state.syncedEvents.length ? Math.max(...state.syncedEvents.map(n => n.timeMs)) : 0;
  const durationRatio = lastMapped / targetDuration;
  const artistSimilarity = tokenSimilarity(state.metadata.bms.artist, state.metadata.osu.artist);
  const titleSimilarity = tokenSimilarity(state.metadata.bms.title, state.metadata.osu.title);
  const identitySimilarity = Math.max(artistSimilarity, titleSimilarity);
  const audioStrength = Math.max(sync.globalScore, sync.confidence);

  const audioStrong = audioStrength >= 0.060 || sync.confidence >= 0.100 || (sync.anchors.length >= 3 && sync.residualMs <= 60);
  const rhythmStrong = phaseRatio >= 0.080;
  const identityStrong = artistSimilarity >= 0.25 || titleSimilarity >= 0.30;
  const artistComparable = Boolean(state.metadata.bms.artist && state.metadata.osu.artist);
  const titleComparable = Boolean(state.metadata.bms.title && state.metadata.osu.title);
  const artistMismatch = artistComparable && artistSimilarity < 0.08;
  const titleMismatch = titleComparable && titleSimilarity < 0.08;
  const identityContradiction = artistMismatch && titleMismatch;
  const spanPlausible = durationRatio >= 0.45 && durationRatio <= 1.80;

  // Mode is a true incompatibility for this converter, not just a weak signal.
  if (state.targetMode !== 3) hardReasons.push(`Target .osu Mode is ${state.targetMode}; this converter requires osu!mania Mode 3.`);

  // Only hard-block a song pair when several independent signals agree that it
  // is unrelated. BMS keysound renders and mastered osu audio can correlate
  // surprisingly weakly even for a legitimate pair, so a single weak metric
  // must never be enough to reject it.
  const catastrophicAudioMismatch =
    audioStrength < 0.015 &&
    sync.anchors.length === 0 &&
    phaseRatio < 0.015 &&
    identityContradiction &&
    !spanPlausible;

  const multiSignalMismatch =
    audioStrength < 0.025 &&
    sync.anchors.length === 0 &&
    phaseRatio < 0.020 &&
    identityContradiction &&
    !spanPlausible;

  if (catastrophicAudioMismatch) {
    hardReasons.push("Audio, rhythm, and map identity all disagree strongly; this looks like a different song.");
  } else if (multiSignalMismatch) {
    hardReasons.push("Multiple independent checks disagree (weak audio match, weak rhythmic agreement, different identity, and incompatible song span).");
  }

  // These are diagnostic warnings. They are intentionally NOT blockers on
  // their own because remasters, sparse target difficulties, translated
  // metadata, and BMS stem mixes can legitimately trigger them.
  if (audioStrength < 0.040) warnings.push(`Audio fingerprint correlation is weak (${audioStrength.toFixed(3)}).`);
  if (sync.anchors.length === 0) warnings.push("No reliable local audio-sync anchors were found.");
  if (sync.anchors.length >= 3 && sync.residualMs > 75) warnings.push(`Audio alignment is locally unstable (${sync.residualMs.toFixed(1)} ms residual).`);
  if (state.phaseBeatLocks.length >= 12 && phaseRatio < 0.035) warnings.push(`BMS rhythm has low agreement with target red-line timing (${(phaseRatio * 100).toFixed(1)}% beat locks).`);
  if (durationRatio < 0.45 || durationRatio > 1.80) warnings.push(`Mapped BMS span differs substantially from target audio length (${durationRatio.toFixed(2)}×).`);
  if (artistMismatch) warnings.push("Artist metadata differs between the BMS and selected .osu.");
  if (titleMismatch) warnings.push("Title metadata differs between the BMS and selected .osu.");

  // Positive evidence decides whether an otherwise plausible pair can proceed
  // silently or should ask the user for confirmation.
  const evidence =
    (audioStrong ? 2 : audioStrength >= 0.040 ? 1 : 0) +
    (rhythmStrong ? 1 : 0) +
    (sync.anchors.length >= 3 ? 1 : 0) +
    (identityStrong ? 2 : identitySimilarity >= 0.12 ? 1 : 0) +
    (spanPlausible ? 1 : 0);

  const metrics = [
    `Audio match: ${audioStrength.toFixed(3)} (sync confidence ${sync.confidence.toFixed(3)})`,
    `Local anchors: ${sync.anchors.length}${sync.anchors.length >= 3 ? `, residual ${sync.residualMs.toFixed(1)} ms` : ""}`,
    `BMS ↔ red-line beat agreement: ${(phaseRatio * 100).toFixed(1)}% (${phaseLocked}/${state.phaseBeatLocks.length || 0})`,
    `Mapped BMS span / target audio: ${durationRatio.toFixed(2)}×`,
    `Title similarity: ${(titleSimilarity * 100).toFixed(0)}%`,
    `Artist similarity: ${(artistSimilarity * 100).toFixed(0)}%`,
    `Evidence score: ${evidence}`,
  ];

  let level: PairCompatibilityLevel = "pass";
  let reasons: string[] = [];
  if (hardReasons.length) {
    level = "fail";
    reasons = hardReasons;
  } else if (evidence < 2) {
    level = "warning";
    reasons = warnings.length ? warnings : ["The pair has too little corroborating evidence to verify automatically."];
  } else {
    // Keep non-fatal warnings in the diagnostics log, but do not interrupt a
    // pair that has enough positive corroboration.
    reasons = warnings;
  }

  return {
    level,
    ok: level !== "fail",
    reasons,
    metrics,
    summary: `pair check: ${level} · audio ${audioStrength.toFixed(3)} · ${sync.anchors.length} anchors · BMS/red-line ${(phaseRatio * 100).toFixed(1)}% · span ${durationRatio.toFixed(2)}× · evidence ${evidence}`,
  };
}

function activeTimingPoint(timeMs: number): TimingPoint | null {
  let active: TimingPoint | null = null;
  for (const tp of state.timingPoints) {
    if (tp.timeMs <= timeMs) active = tp;
    else break;
  }
  return active;
}

interface SnapCandidate { timeMs: number; distanceMs: number; source: "target" | "phase" | "grid"; }

function uniqueTargetAnchorTimes(): number[] {
  return state.targetAnchorTimes;
}

function nearestIndex(values: number[], value: number): number {
  if (!values.length) return -1;
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  if (lo <= 0) return 0;
  if (lo >= values.length) return values.length - 1;
  return Math.abs(values[lo] - value) < Math.abs(values[lo - 1] - value) ? lo : lo - 1;
}

/** Build the target's quarter-note beat lattice exactly from its red timing points. */
function buildTargetBeatLattice(): number[] {
  if (!state.timingPoints.length) return [];
  const songEnd = Math.max(state.songLengthMs, state.targetAudioBuffer?.duration ? state.targetAudioBuffer.duration * 1000 : 0);
  const beats: number[] = [];
  for (let i = 0; i < state.timingPoints.length; i++) {
    const tp = state.timingPoints[i];
    const end = i + 1 < state.timingPoints.length ? state.timingPoints[i + 1].timeMs : songEnd + tp.beatLength;
    if (!(tp.beatLength > 0) || end <= tp.timeMs) continue;
    const count = Math.ceil((end - tp.timeMs) / tp.beatLength) + 1;
    for (let k = 0; k < count; k++) {
      const t = tp.timeMs + k * tp.beatLength;
      if (t >= end - 1e-6) break;
      if (t >= -10000 && t <= songEnd + 10000) beats.push(t);
    }
  }
  beats.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const t of beats) if (!unique.length || Math.abs(t - unique[unique.length - 1]) > .25) unique.push(t);
  return unique;
}

/** Coarse beat-to-beat locks used as one fallback. */
function rebuildPhaseBeatLocks(): void {
  state.phaseBeatLocks = Array.from({ length: state.bmsBeatTimes.length }, () => null);
  if (!state.sync || !state.bmsBeatTimes.length) return;
  const targetBeats = buildTargetBeatLattice();
  if (!targetBeats.length) return;
  let previousTarget = -1;
  for (let i = 0; i < state.bmsBeatTimes.length; i++) {
    const mapped = mapBmsTime(state.bmsBeatTimes[i], state.sync);
    const j = nearestIndex(targetBeats, mapped);
    if (j < 0 || j <= previousTarget) continue;
    const distanceMs = Math.abs(targetBeats[j] - mapped);
    if (distanceMs > 35) continue;
    state.phaseBeatLocks[i] = { targetIndex: j, targetMs: targetBeats[j], distanceMs };
    previousTarget = j;
  }
}

function exactBmsBeatPhase(note: Note): number | null {
  const num = note.positionNum;
  const den = note.positionDen;
  const measureLength = note.measureLength;
  if (!Number.isFinite(num) || !Number.isFinite(den) || !Number.isFinite(measureLength) || !den || !measureLength) return null;
  const beatPosition = (num! / den!) * (4 * measureLength!);
  let phase = beatPosition - Math.floor(beatPosition + 1e-9);
  if (phase < 1e-7 || phase > 1 - 1e-7) phase = 0;
  return phase;
}

/**
 * Deep structural fallback: preserve the exact fractional BMS position inside
 * a quarter beat, but place it on the target .osu red-line timing. Unlike the
 * old "try every divisor and pick the nearest" method, this uses the source
 * BMS rational itself, so it remains deterministic around sparse target diffs.
 */
function structuralPhaseAnchor(note: Note): SnapCandidate | null {
  const phase = exactBmsBeatPhase(note);
  if (phase === null || !state.timingPoints.length) return null;
  let best = Number.NaN;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let j = 0; j < state.timingPoints.length; j++) {
    const tp = state.timingPoints[j];
    const segEnd = state.timingPoints[j + 1]?.timeMs ?? state.songLengthMs + tp.beatLength;
    if (note.timeMs < tp.timeMs - 250 || note.timeMs > segEnd + 250) continue;
    const approx = (note.timeMs - tp.timeMs) / tp.beatLength - phase;
    const baseK = Math.round(approx);
    for (let dk = -2; dk <= 2; dk++) {
      const k = baseK + dk;
      const candidate = tp.timeMs + (k + phase) * tp.beatLength;
      if (candidate < tp.timeMs - .5 || candidate >= segEnd + .5) continue;
      const d = Math.abs(candidate - note.timeMs);
      if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) < 1e-9 && candidate < best)) {
        bestDistance = d;
        best = candidate;
      }
    }
  }
  if (!Number.isFinite(best)) return null;
  const snapped = Math.floor(best + 1e-7);
  return { timeMs: snapped, distanceMs: Math.abs(snapped - note.timeMs), source: "phase" };
}

/** Older beat-lock phase projection kept as a secondary fallback for files that
 * pre-date the structural fields or contain unusual variable-length measures. */
function lockedPhaseAnchor(note: Note): SnapCandidate | null {
  const raw = note.sourceTimeMs;
  if (!Number.isFinite(raw) || state.bmsBeatTimes.length < 2 || !state.phaseBeatLocks.length) return null;
  let lo = 0;
  let hi = state.bmsBeatTimes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (state.bmsBeatTimes[mid] <= raw!) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  if (i < 0 || i + 1 >= state.bmsBeatTimes.length) return null;
  const left = state.phaseBeatLocks[i];
  const right = state.phaseBeatLocks[i + 1];
  if (!left || !right || right.targetIndex !== left.targetIndex + 1) return null;
  const b0 = state.bmsBeatTimes[i];
  const b1 = state.bmsBeatTimes[i + 1];
  if (!(b1 > b0)) return null;
  const phase = clamp((raw! - b0) / (b1 - b0), 0, 1);
  const projected = left.targetMs + phase * (right.targetMs - left.targetMs);
  const snapped = Math.floor(projected + 1e-7);
  return { timeMs: snapped, distanceMs: Math.abs(snapped - note.timeMs), source: "phase" };
}

function nativePhaseAnchor(note: Note): SnapCandidate | null {
  return structuralPhaseAnchor(note) ?? lockedPhaseAnchor(note);
}

const COMMON_SNAP_DIVISORS = [1, 2, 3, 4, 6, 8, 12, 16];

function nearestCommonGridAnchor(timeMs: number): SnapCandidate | null {
  if (!state.timingPoints.length) return null;
  let best = Number.NaN;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < state.timingPoints.length; i++) {
    const tp = state.timingPoints[i];
    const segEnd = state.timingPoints[i + 1]?.timeMs ?? state.songLengthMs + tp.beatLength;
    if (timeMs < tp.timeMs - 100 || timeMs > segEnd + 100) continue;
    for (const divisor of COMMON_SNAP_DIVISORS) {
      const step = tp.beatLength / divisor;
      const k = Math.round((timeMs - tp.timeMs) / step);
      const candidate = tp.timeMs + k * step;
      if (candidate < tp.timeMs - .5 || candidate >= segEnd + .5) continue;
      const snapped = Math.floor(candidate + 1e-7);
      const d = Math.abs(snapped - timeMs);
      if (d < bestDistance - 1e-9 || (Math.abs(d - bestDistance) < 1e-9 && snapped < best)) {
        bestDistance = d;
        best = snapped;
      }
    }
  }
  return Number.isFinite(best) ? { timeMs: best, distanceMs: bestDistance, source: "grid" } : null;
}

function isAlreadyGridSnapped(timeMs: number, epsilon = 1.25): boolean {
  const c = nearestCommonGridAnchor(timeMs);
  return !!c && c.distanceMs <= epsilon;
}

function bestTargetAnchor(note: Note, phase: SnapCandidate | null, searchMs: number, thorough: boolean): SnapCandidate | null {
  if (state.targetMode !== 3 || !state.targetAnchorTimes.length) return null;
  const anchors = uniqueTargetAnchorTimes();
  if (!anchors.length) return null;
  const tolerance = Math.max(0, Number(snapTolerance.value) || 0);
  const phaseAgreementMs = thorough ? Math.max(12, Math.min(22, tolerance + 8)) : Math.max(7, Math.min(14, tolerance));
  const conservativeNoPhaseMs = Math.max(4, Math.min(12, tolerance));

  let lo = 0;
  let hi = anchors.length;
  const min = note.timeMs - searchMs;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (anchors[mid] < min) lo = mid + 1;
    else hi = mid;
  }
  let bestTime = Number.NaN;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = lo; i < anchors.length; i++) {
    const t = anchors[i];
    if (t > note.timeMs + searchMs) break;
    const syncDistance = Math.abs(t - note.timeMs);
    const phaseDistance = phase ? Math.abs(t - phase.timeMs) : Number.POSITIVE_INFINITY;
    if (phase) {
      if (phaseDistance > phaseAgreementMs) continue;
    } else if (syncDistance > conservativeNoPhaseMs) continue;
    const score = phase ? syncDistance * .25 + phaseDistance * .75 : syncDistance;
    if (score < bestScore - 1e-9 || (Math.abs(score - bestScore) < 1e-9 && t < bestTime)) {
      bestScore = score;
      bestTime = t;
    }
  }
  return Number.isFinite(bestTime) ? { timeMs: bestTime, distanceMs: Math.abs(bestTime - note.timeMs), source: "target" } : null;
}

/** A slow rescue used only when the source timestamp itself is visibly off-grid.
 * This is what fixes isolated +2/+3/+14/+17 ms verifier warnings without
 * pulling already-valid BMS 1/16 notes onto a sparse gameplay difficulty. */
function deepTargetRescue(note: Note, maxDistanceMs: number): SnapCandidate | null {
  if (state.targetMode !== 3 || !state.targetAnchorTimes.length || isAlreadyGridSnapped(note.timeMs)) return null;
  const i = nearestIndex(state.targetAnchorTimes, note.timeMs);
  if (i < 0) return null;
  const t = state.targetAnchorTimes[i];
  const d = Math.abs(t - note.timeMs);
  return d <= maxDistanceMs ? { timeMs: t, distanceMs: d, source: "target" } : null;
}

let lastSnapStats = { target: 0, phase: 0, grid: 0, unchanged: 0 };

function resnapEvents(source: Note[]): Note[] {
  lastSnapStats = { target: 0, phase: 0, grid: 0, unchanged: 0 };
  if (!resnap.checked || !source.length) {
    lastSnapStats.unchanged = source.length;
    return source.map(n => ({ ...n }));
  }

  const tolerance = Math.max(0, Number(snapTolerance.value) || 0);
  const thorough = (resnapMode.value as ResnapMode) === "thorough";
  const targetSearch = thorough ? Math.max(64, tolerance * 3) : Math.max(28, tolerance);
  const phaseSearch = thorough ? Math.max(80, tolerance * 4) : Math.max(30, tolerance * 2);
  const deepTargetSearch = thorough ? Math.max(36, tolerance * 2.5) : Math.max(18, tolerance);
  const gridSearch = thorough ? Math.max(20, tolerance + 6) : Math.max(8, tolerance);

  return source.map(note => {
    const phase = nativePhaseAnchor(note);
    const target = bestTargetAnchor(note, phase, phase ? targetSearch : Math.max(12, tolerance), thorough);
    if (target) {
      lastSnapStats.target++;
      return { ...note, timeMs: target.timeMs };
    }

    if (phase && phase.distanceMs <= phaseSearch) {
      // Keep exact BMS structure when it already lands on a normal osu! snap.
      // If the source phase itself is an odd/free-timed subdivision, do a
      // deeper target/grid check instead of preserving a verifier-visible
      // +2/+14/+17 ms float forever.
      if (isAlreadyGridSnapped(phase.timeMs)) {
        lastSnapStats.phase++;
        return { ...note, timeMs: phase.timeMs };
      }
      const rescueFromPhase = deepTargetRescue(note, deepTargetSearch);
      if (rescueFromPhase) {
        lastSnapStats.target++;
        return { ...note, timeMs: rescueFromPhase.timeMs };
      }
      const phaseGrid = nearestCommonGridAnchor(phase.timeMs);
      if (phaseGrid && phaseGrid.distanceMs <= gridSearch) {
        lastSnapStats.grid++;
        return { ...note, timeMs: phaseGrid.timeMs };
      }
      lastSnapStats.phase++;
      return { ...note, timeMs: phase.timeMs };
    }

    const rescue = deepTargetRescue(note, deepTargetSearch);
    if (rescue) {
      lastSnapStats.target++;
      return { ...note, timeMs: rescue.timeMs };
    }

    const grid = nearestCommonGridAnchor(note.timeMs);
    if (grid && grid.distanceMs <= gridSearch) {
      lastSnapStats.grid++;
      return { ...note, timeMs: grid.timeMs };
    }

    lastSnapStats.unchanged++;
    return { ...note };
  });
}

function outputEvents(): Note[] {
  // BMS background / invisible sounds are always promoted. This converter is
  // a keysound-diff generator, so silently sending any audible layer back to
  // storyboard audio would defeat the purpose.
  return resnapEvents(state.syncedEvents);
}

const MAX_OUTPUT_KEYS = 18;
const MIN_LANE_REUSE_MS = 28; // Mapset Verifier warns at <=27 ms in one lane.

function laneMap(events: Note[], keys: number): Map<string, number> {
  const m = new Map<string, number>();
  for (const n of events) if (!m.has(n.wavId)) m.set(n.wavId, m.size % keys);
  return m;
}

/** Minimum number of mania columns needed so no two generated objects have to
 * reuse the same column within Mapset Verifier's <28 ms concurrency window. */
function minimumKeysRequired(events: Note[]): number {
  if (!events.length) return 1;
  const times = events.map(n => Math.round(n.timeMs)).sort((a, b) => a - b);
  let left = 0;
  let maxConcurrent = 1;
  for (let right = 0; right < times.length; right++) {
    while (left < right && times[right] - times[left] >= MIN_LANE_REUSE_MS) left++;
    maxConcurrent = Math.max(maxConcurrent, right - left + 1);
  }
  return maxConcurrent;
}

function updateAutoKeyBounds(): void {
  if (!state.syncedEvents.length) return;
  const required = minimumKeysRequired(outputEvents());
  state.requiredKeys = required;
  const minimum = Math.min(MAX_OUTPUT_KEYS, Math.max(1, required));
  keysInput.min = String(minimum);
  keysInput.max = String(MAX_OUTPUT_KEYS);
  keysInput.value = String(minimum);
  if (required > MAX_OUTPUT_KEYS) {
    appendLog(`[WARN] This chart needs ${required} lanes to avoid every <${MIN_LANE_REUSE_MS} ms lane reuse; output is capped at ${MAX_OUTPUT_KEYS}K and rare overflow groups will be composited.`);
  } else {
    appendLog(`Auto key count: ${minimum}K (minimum needed to avoid same-lane objects within ${MIN_LANE_REUSE_MS - 1} ms).`);
  }
  invalidateConvertedPlacement();
}

/** Build exactly the same lane/collision result used by final conversion. */
let convertedPlacementCache: { keys: number; result: { notes: PlacedPreviewNote[]; shifted: number; stacked: number; nearShifted: number; nearConflicts: number } } | null = null;
let preparationGeneration = 0;
function invalidateConvertedPlacement(): void {
  convertedPlacementCache = null;
}

function invalidatePreviewAudio(): void {
  preparationGeneration++;
  preparedPreviews.clear();
  pendingPreviews.clear();
  invalidateConvertedPlacement();
  state.convertedMixBuffer = null;
  for (const key of [...state.tempoMixBuffers.keys()]) if ((key.startsWith("converted@") || key.startsWith("pair-converted@"))) state.tempoMixBuffers.delete(key);
}

function buildConvertedPlacement(keys: number): { notes: PlacedPreviewNote[]; shifted: number; stacked: number; nearShifted: number; nearConflicts: number } {
  const minKeys = Math.min(MAX_OUTPUT_KEYS, Math.max(1, state.requiredKeys || 1));
  const safeKeys = clamp(Math.floor(keys || minKeys), minKeys, MAX_OUTPUT_KEYS);
  if (convertedPlacementCache?.keys === safeKeys) return convertedPlacementCache.result;

  const events = outputEvents().sort((a, b) => a.timeMs - b.timeMs || a.wavId.localeCompare(b.wavId));
  const baseLane = laneMap(events, safeKeys);
  const buckets = new Map<number, Note[]>();
  for (const n of events) {
    const t = Math.round(n.timeMs);
    const list = buckets.get(t) ?? [];
    list.push({ ...n, timeMs: t });
    buckets.set(t, list);
  }

  const notes: PlacedPreviewNote[] = [];
  const lastUsed = new Array<number>(safeKeys).fill(Number.NEGATIVE_INFINITY);
  let shifted = 0;
  let stacked = 0;
  let nearShifted = 0;
  let nearConflicts = 0;

  for (const [time, simultaneous] of [...buckets].sort((a, b) => a[0] - b[0])) {
    const occupiedNow = new Array<boolean>(safeKeys).fill(false);
    const noteIndexByLane = new Array<number>(safeKeys).fill(-1);
    simultaneous.sort((a, b) => (baseLane.get(a.wavId) ?? 0) - (baseLane.get(b.wavId) ?? 0) || a.wavId.localeCompare(b.wavId));

    const laneAvailable = (lane: number) => !occupiedNow[lane] && time - lastUsed[lane] >= MIN_LANE_REUSE_MS;

    for (const note of simultaneous) {
      const base = baseLane.get(note.wavId) ?? 0;
      let lane = base;
      const baseBlockedByRecent = time - lastUsed[base] < MIN_LANE_REUSE_MS;

      if (!laneAvailable(lane)) {
        let freeLane = -1;
        for (let d = 1; d < safeKeys && freeLane < 0; d++) {
          if (base + d < safeKeys && laneAvailable(base + d)) freeLane = base + d;
          else if (base - d >= 0 && laneAvailable(base - d)) freeLane = base - d;
        }
        if (freeLane >= 0) {
          lane = freeLane;
          shifted++;
          if (baseBlockedByRecent) nearShifted++;
        } else {
          // This only happens when the requested/capped key count is below the
          // rolling concurrency requirement. Prefer compositing exact-time
          // layers; never send them back to storyboard audio.
          let mergeLane = -1;
          let bestLayers = Number.POSITIVE_INFINITY;
          for (let candidate = 0; candidate < safeKeys; candidate++) {
            const idx = noteIndexByLane[candidate];
            if (idx < 0) continue;
            const layers = notes[idx].wavIds.length;
            if (layers < bestLayers) { bestLayers = layers; mergeLane = candidate; }
          }
          if (mergeLane >= 0) {
            const existing = notes[noteIndexByLane[mergeLane]];
            existing.wavIds.push(note.wavId);
            existing.isBgm = existing.isBgm && note.isBgm;
            existing.compositeKey = `${time}_L${mergeLane + 1}`;
            stacked++;
            continue;
          }

          // No current-time object exists to carry a composite. This is only
          // possible if the chart truly needs >18 rolling lanes. Pick the
          // least-recently-used lane and report it explicitly.
          lane = 0;
          for (let candidate = 1; candidate < safeKeys; candidate++) if (lastUsed[candidate] < lastUsed[lane]) lane = candidate;
          nearConflicts++;
          shifted++;
        }
      }

      occupiedNow[lane] = true;
      lastUsed[lane] = time;
      notes.push({ timeMs: time, endTimeMs: time, lane, wavId: note.wavId, wavIds: [note.wavId], isBgm: note.isBgm });
      noteIndexByLane[lane] = notes.length - 1;
    }
  }

  const result = { notes, shifted, stacked, nearShifted, nearConflicts };
  convertedPlacementCache = { keys: safeKeys, result };
  return result;
}

let scrollTimelineSource: typeof state.scrollPoints | null = null;
let scrollTimeline: { timeMs: number; multiplier: number; distance: number }[] = [];
function scrollCoordinate(timeMs: number): number {
  if (scrollTimelineSource !== state.scrollPoints) {
    scrollTimelineSource = state.scrollPoints;
    scrollTimeline = [];
    let distance = 0, previousTime = 0, multiplier = 1;
    for (const p of state.scrollPoints) {
      distance += (p.timeMs - previousTime) * multiplier;
      scrollTimeline.push({ ...p, distance });
      previousTime = p.timeMs; multiplier = p.multiplier;
    }
  }
  let lo = 0, hi = scrollTimeline.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (scrollTimeline[mid].timeMs <= timeMs) lo = mid + 1; else hi = mid; }
  const p = scrollTimeline[lo - 1];
  return p ? p.distance + (timeMs - p.timeMs) * p.multiplier : timeMs;
}
function previewScrollDistance(startMs: number, endMs: number): number {
  return $<HTMLInputElement>("view-sv").checked ? scrollCoordinate(endMs) - scrollCoordinate(startMs) : endMs - startMs;
}
function previewVisibleEnd(nowMs: number, horizonMs: number): number {
  if (!$<HTMLInputElement>("view-sv").checked) return nowMs + horizonMs;
  let lo = nowMs, hi = Math.max(nowMs + horizonMs, state.songLengthMs);
  for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2;
    if (previewScrollDistance(nowMs, mid) < horizonMs) lo = mid; else hi = mid;
  }
  return hi;
}
$("view-sv").onchange = drawNotePreview;
function previewNoteColor(keys: number, lane: number, source: "converted" | "target"): string {
  if (source === "converted") return "#ff66ab";
  const native = state.standaloneKind === "bms";
  const scratch = native && ((keys === 6 || keys === 8) ? lane === 0 : (keys === 12 || keys === 16) && (lane === 0 || lane === keys / 2));
  if (scratch) return "#ff855e";
  if (keys % 2 && lane === Math.floor(keys / 2)) return native ? "#ffba66" : "#ffda32";
  return Math.min(lane, keys - 1 - lane) % 2 ? (native ? "#4ce0bd" : "#2fc3f3") : (native ? "#fff0cf" : "#ffffff");
}
function noteY(timeMs: number, nowMs: number, horizonMs: number, pastMs: number, top: number, judgmentY: number, bottom: number): number {
  if (timeMs >= nowMs) {
    const ratio = Math.min(1, previewScrollDistance(nowMs, timeMs) / horizonMs);
    return judgmentY - ratio * (judgmentY - top);
  }
  const ratio = Math.min(1, (nowMs - timeMs) / pastMs);
  return judgmentY + ratio * (bottom - judgmentY);
}

function drawPreviewNote(
  ctx: CanvasRenderingContext2D,
  note: TargetPreviewNote,
  sourceKeys: number,
  source: "converted" | "target",
  nowMs: number,
  horizonMs: number,
  pastMs: number,
  width: number,
  top: number,
  judgmentY: number,
  bottom: number,
  isBgm = false,
): void {
  // A hold remains visible until its tail reaches NOW; taps end at their head.
  const isHold = note.endTimeMs > note.timeMs + 1;
  const visibleEndMs = isHold ? note.endTimeMs : note.timeMs;
  if (visibleEndMs < nowMs - .5 || previewScrollDistance(nowMs, Math.max(nowMs, note.timeMs)) > horizonMs) return;
  const keys = clamp(Math.max(1, sourceKeys), 1, MAX_OUTPUT_KEYS);
  const slotW = width / MAX_OUTPUT_KEYS;
  const playfieldW = slotW * keys;
  const playfieldLeft = (width - playfieldW) / 2;
  const laneW = slotW;
  const pad = Math.min(3, Math.max(1, laneW * .08));
  const x = playfieldLeft + note.lane * laneW + pad;
  const w = Math.max(2, laneW - pad * 2);
  const yHead = noteY(isHold ? Math.max(note.timeMs, nowMs) : note.timeMs, nowMs, horizonMs, pastMs, top, judgmentY, bottom);
  const yEnd = noteY(note.endTimeMs, nowMs, horizonMs, pastMs, top, judgmentY, bottom);
  const leadMs = note.timeMs - nowMs;

  const glowColor = previewNoteColor(keys, note.lane, source);
  ctx.fillStyle = glowColor;
  ctx.strokeStyle = source === "converted" && isBgm ? "#ffd0e5" : glowColor;

  ctx.save();
  // A small piano-key/ash-like bloom just before contact. Keep it subtle so
  // dense 18K sections remain readable.
  if (leadMs >= 0 && leadMs <= 70) {
    const strength = 1 - leadMs / 70;
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = 1.5 + 4.5 * strength;
    ctx.globalAlpha = .92 + .08 * strength;
  }
  if (isHold) {
    const bodyTop = Math.min(yHead, yEnd);
    const bodyBottom = Math.max(yHead, yEnd);
    ctx.globalAlpha = source === "target" ? .85 : .68;
    const inset = source === "target" ? 0 : w * .2;
    ctx.fillRect(x + inset, bodyTop, w - inset * 2, Math.max(3, bodyBottom - bodyTop));
    ctx.globalAlpha = 1;
  }
  const noteH = Math.max(5, Math.min(10, laneW * .28));
  ctx.beginPath();
  ctx.roundRect(x, yHead - noteH, w, noteH, source === "target" ? 0 : Math.min(4, noteH / 2));
  ctx.fill();
  ctx.lineWidth = leadMs <= 90 ? 1.55 : 1;
  ctx.stroke();
  ctx.restore();
}

function drawPlayfieldGrid(
  ctx: CanvasRenderingContext2D,
  keys: number,
  width: number,
  top: number,
  bottom: number,
  edgeColor: string,
  laneColor: string,
): void {
  const safeKeys = clamp(Math.round(keys), 1, MAX_OUTPUT_KEYS);
  const slotW = width / MAX_OUTPUT_KEYS;
  const fieldW = safeKeys * slotW;
  const left = (width - fieldW) / 2;
  const right = left + fieldW;
  ctx.fillStyle = "rgba(255,255,255,.012)";
  ctx.fillRect(left, top, fieldW, bottom - top);
  ctx.strokeStyle = laneColor;
  ctx.lineWidth = 1;
  for (let lane = 1; lane < safeKeys; lane++) {
    const x = left + lane * slotW;
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  }
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = 2;
  for (const x of [left, right]) {
    ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
  }
}

function updateKeyVisualizer(keys: number, notes: PlacedPreviewNote[], nowMs: number): void {
  const safeKeys = clamp(Math.round(keys || 1), 1, MAX_OUTPUT_KEYS);
  if (keyVisualizer.children.length !== safeKeys) {
    keyVisualizer.replaceChildren();
    for (let i = 0; i < safeKeys; i++) {
      const key = document.createElement("span");
      key.className = "key-cap";
      key.title = `Key ${i + 1}`;
      keyVisualizer.appendChild(key);
    }
  }
  const active = new Set<number>();
  let kps = 0;
  for (const note of notes) {
    if (note.timeMs > nowMs) break;
    if (note.timeMs > nowMs - 1000) kps++;
    const held = note.endTimeMs > note.timeMs && nowMs < note.endTimeMs;
    if (held || nowMs < note.timeMs + 55) active.add(note.lane);
  }
  $("key-kps").textContent = kps + " KPS";
  Array.from(keyVisualizer.children).forEach((el, lane) => el.classList.toggle("active", active.has(lane)));
}

function drawNotePreview(): void {
  const rect = noteCanvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  noteCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  noteCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = noteCanvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const width = rect.width;
  const height = rect.height;
  const top = 28;
  const judgmentY = height - 18;
  const bottom = height - 6;
  const scrollSpeed = clamp(Number(notePreviewSpeed.value) || 28, 1, 40);
  // osu!mania-like readable approach window requested by the user:
  // speed 40 ≈ 287 ms, speed 1 ≈ 11.48 s (inverse relationship).
  const horizonMs = 11480 / scrollSpeed;
  const pastMs = 1;
  const nowMs = Number(timeline.value || 0) * 1000;
  const mode: NotePreviewMode = state.standaloneKind ? "target" : notePreviewMode.value as NotePreviewMode;
  const outputKeys = clamp(Number(keysInput.value) || state.requiredKeys || 18, 1, MAX_OUTPUT_KEYS);
  const targetKeys = clamp(state.targetKeys || 4, 1, MAX_OUTPUT_KEYS);
  const placement = state.standaloneKind
    ? { notes: [] as PlacedPreviewNote[], shifted: 0, stacked: 0, nearShifted: 0, nearConflicts: 0 }
    : buildConvertedPlacement(outputKeys);

  ctx.fillStyle = "rgba(255,255,255,.018)";
  ctx.fillRect(0, 0, width, height);

  // All playfields use the same physical lane width as an 18K field and are
  // centered. A 4K target therefore stays a compact 4-column field rather than
  // stretching across the entire canvas.
  if (mode === "converted" || mode === "overlay") {
    drawPlayfieldGrid(ctx, outputKeys, width, top, bottom, "rgba(255,102,171,.42)", "rgba(255,255,255,.055)");
  }
  if ((mode === "target" || mode === "overlay") && state.targetMode === 3) {
    drawPlayfieldGrid(ctx, targetKeys, width, top, bottom, "rgba(140,102,255,.92)", "rgba(140,102,255,.16)");
  }

  for (const line of viewGridLines(nowMs, previewVisibleEnd(nowMs, horizonMs))) {
    const y = noteY(line.timeMs, nowMs, horizonMs, pastMs, top, judgmentY, bottom);
    ctx.strokeStyle = line.beat ? "rgba(255,255,255,.16)" : "rgba(255,153,199,.08)";
    ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }

  ctx.strokeStyle = "rgba(255,255,255,.9)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(0, judgmentY); ctx.lineTo(width, judgmentY); ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.65)";
  ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
  ctx.fillText("NOW", 7, judgmentY - 6);

  if ((mode === "target" || mode === "overlay") && state.targetMode === 3) {
    for (const note of state.targetNotes) drawPreviewNote(ctx, note, targetKeys, "target", nowMs, horizonMs, pastMs, width, top, judgmentY, bottom);
  }
  if (mode === "converted" || mode === "overlay") {
    for (const note of placement.notes) drawPreviewNote(ctx, note, outputKeys, "converted", nowMs, horizonMs, pastMs, width, top, judgmentY, bottom, note.isBgm);
  }

  updateKeyVisualizer(state.standaloneKind ? targetKeys : outputKeys, state.standaloneKind ? state.targetNotes as PlacedPreviewNote[] : placement.notes, nowMs);

  if (state.standaloneKind) {
    notePreviewInfo.textContent = `Original ${state.standaloneKind === "bms" ? "BMS" : "osu!mania"} · ${targetKeys} ${state.standaloneKind === "bms" ? "lanes" : "keys"} · ${state.targetNotes.length} notes · speed ${scrollSpeed}`;
  } else if (!state.sync) {
    notePreviewInfo.textContent = "Analyze maps to preview notes";
  } else if ((mode === "target" || mode === "overlay") && state.targetMode !== 3) {
    notePreviewInfo.textContent = `Target Mode ${state.targetMode} is not osu!mania · converted ${placement.notes.length} notes`;
  } else if (mode === "target") {
    notePreviewInfo.textContent = `Target ${targetKeys}K · ${state.targetNotes.length} objects · speed ${scrollSpeed.toFixed(0)} (${Math.round(horizonMs)} ms)`;
  } else if (mode === "overlay") {
    const mismatch = outputKeys !== targetKeys ? " · centered fixed-width fields" : "";
    notePreviewInfo.textContent = `Converted ${outputKeys}K ${placement.notes.length} · Target ${targetKeys}K ${state.targetNotes.length}${mismatch} · speed ${scrollSpeed.toFixed(0)} (${Math.round(horizonMs)} ms)`;
  } else {
    notePreviewInfo.textContent = `Converted ${outputKeys}K · ${placement.notes.length} notes${placement.nearShifted ? ` · ${placement.nearShifted} near-collision shifts` : ""} · speed ${scrollSpeed.toFixed(0)} (${Math.round(horizonMs)} ms)`;
  }
}

function drawWaveform(): void {
  const b = state.standaloneKind === "bms" ? state.referenceMixBuffer ?? state.targetAudioBuffer : state.targetAudioBuffer;
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  if (!b) {
    ctx.strokeStyle = "rgba(255,255,255,.08)";
    ctx.beginPath();
    ctx.moveTo(0, rect.height / 2);
    ctx.lineTo(rect.width, rect.height / 2);
    ctx.stroke();
    return;
  }

  const data = b.getChannelData(0);
  const mid = rect.height / 2;
  const width = Math.max(1, Math.floor(rect.width));
  const gradient = ctx.createLinearGradient(0, 0, rect.width, 0);
  gradient.addColorStop(0, "#ff99c7");
  gradient.addColorStop(.55, "#ff66ab");
  gradient.addColorStop(1, "#8c66ff");
  ctx.strokeStyle = gradient;
  ctx.globalAlpha = .88;
  ctx.beginPath();
  const block = Math.max(1, Math.floor(data.length / width));
  for (let x = 0; x < width; x++) {
    let min = 1;
    let max = -1;
    const start = x * block;
    const end = Math.min(data.length, start + block);
    for (let i = start; i < end; i++) {
      const v = data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.moveTo(x, mid + min * mid * .78);
    ctx.lineTo(x, mid + max * mid * .78);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function setPosition(sec: number): void {
  const max = state.songLengthMs / 1000;
  const v = Math.max(0, Math.min(max, sec));
  timeline.value = String(v);
  timeCurrent.textContent = formatTime(v);
  playhead.style.left = `${max > 0 ? (v / max) * 100 : 0}%`;
  drawNotePreview();
  if (!previewPlaying) updateMetronomeReadout(v * 1000);
}

function currentRate(): number {
  return clamp(Number(playbackRate.value) || 1, .25, 2);
}
function currentHitsoundGain(): number {
  if (state.standaloneKind) return 1;
  return clamp(Number(hitsoundVolume.value) || 0, 0, 100) / 100;
}
function currentAudioGain(): number {
  return clamp(Number(audioVolume.value) || 0, 0, 100) / 100;
}

function refreshVolumeLabels(): void {
  hitsoundVolumeOut.value = `${Math.round(Number(hitsoundVolume.value))}%`;
  audioVolumeOut.value = `${Math.round(Number(audioVolume.value))}%`;
  oggQualityOut.value = `q${Number(oggQuality.value).toFixed(1)}`;
  if (activeMasterGain) activeMasterGain.gain.value = state.standaloneKind ? currentAudioGain() : 1;
  if (activeTargetGain) activeTargetGain.gain.value = state.standaloneKind ? 1 : currentAudioGain();
  if (activeSampleGain) activeSampleGain.gain.value = currentHitsoundGain();
}

async function refreshFfmpegStatus(): Promise<void> {
  if (sampleFormat.value !== "ogg") {
    ffmpegStatus.className = "tool-status neutral";
    ffmpegStatus.textContent = "Original-format copy selected — FFmpeg is not required.";
    return;
  }
  ffmpegStatus.className = "tool-status neutral";
  ffmpegStatus.textContent = "Checking FFmpeg…";
  const result = await window.bms2osu.ffmpegStatus();
  if (result.available) {
    ffmpegStatus.className = "tool-status good";
    ffmpegStatus.textContent = `FFmpeg ready${result.executable && result.executable !== "ffmpeg" ? ` · ${result.executable}` : ""}`;
  } else {
    ffmpegStatus.className = "tool-status warn";
    ffmpegStatus.textContent = "FFmpeg not found. Features that need it will show an install prompt with the winget command.";
  }
}

function refreshSampleFormatUi(): void {
  const isOgg = sampleFormat.value === "ogg";
  oggOptions.classList.toggle("disabled", !isOgg);
  oggQuality.disabled = !isOgg;
  void refreshFfmpegStatus();
}

let visualMetronomeIndex = 0;
let visualMetronomeSide = -1;
let visualMetronomePulseTimer = 0;

function metronomeBpmAt(timeMs: number): number | null {
  if ((metronomeSource.value as MetronomeSource) === "osu") {
    const tp = activeTimingPoint(timeMs);
    return tp && tp.beatLength > 0 ? 60000 / tp.beatLength : null;
  }
  const beats = state.syncedBmsBeatTimes;
  if (beats.length < 2) return null;
  let lo = 0, hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (beats[mid] < timeMs) lo = mid + 1; else hi = mid;
  }
  const i = clamp(lo, 1, beats.length - 1);
  const delta = beats[i] - beats[i - 1];
  return delta > 1 ? 60000 / delta : null;
}

function renderMeterBar(meter = 4, activeBeat = -1): void {
  const safeMeter = clamp(Math.round(meter || 4), 1, 16);
  if (metronomeBeatBar.children.length !== safeMeter) {
    metronomeBeatBar.replaceChildren();
    for (let i = 0; i < safeMeter; i++) {
      const el = document.createElement("span");
      el.className = `meter-beat${i === 0 ? " accent" : ""}`;
      metronomeBeatBar.appendChild(el);
    }
  }
  Array.from(metronomeBeatBar.children).forEach((el, i) => el.classList.toggle("active", i === activeBeat));
}

function updateBrandPulse(timeMs: number): void {
  const rawBpm = previewPlaying ? (metronomeBpmAt(timeMs) ?? 60) * currentRate() : 60;
  const effectiveBpm = clamp(rawBpm, 20, 400);
  brandOrb.style.animationDuration = `${(60 / effectiveBpm).toFixed(3)}s`;
}

brandOrb.onclick = () => {
  const count = 18;
  const rect = brandOrb.getBoundingClientRect();
  for (let i = 0; i < count; i++) {
    const flake = document.createElement("span");
    flake.className = "bms-flake";
    flake.textContent = "bms!";
    flake.style.left = `${rect.left + rect.width / 2 + (Math.random() - .5) * 70}px`;
    flake.style.setProperty("--drift", `${(Math.random() - .5) * 220}px`);
    flake.style.setProperty("--spin", `${(Math.random() - .5) * 900}deg`);
    flake.style.animationDuration = `${2.4 + Math.random() * 2.6}s`;
    flake.style.animationDelay = `${Math.random() * .18}s`;
    flake.style.fontSize = `${9 + Math.random() * 7}px`;
    snowLayer.appendChild(flake);
    flake.addEventListener("animationend", () => flake.remove(), { once: true });
  }
};

function updateMetronomeReadout(timeMs: number): void {
  const bpm = metronomeBpmAt(timeMs);
  metronomeBpm.textContent = bpm && Number.isFinite(bpm) ? `${bpm.toFixed(bpm >= 100 ? 1 : 2)} BPM` : "— BPM";
  updateBrandPulse(timeMs);
}

function resetVisualMetronome(): void {
  visualMetronomeIndex = 0;
  visualMetronomeSide = -1;
  window.clearTimeout(visualMetronomePulseTimer);
  metronomeModel.classList.remove("metronome-pulse", "metronome-accent");
  metronomeStick.style.transitionDuration = "180ms";
  metronomeStick.style.transform = "translateX(-50%) rotate(0deg)";
  metronomeBeatLabel.textContent = metronomeEnabled.checked ? "ready" : "off";
  const tp = activeTimingPoint(Number(timeline.value) * 1000);
  renderMeterBar(tp?.meter ?? 4, -1);
  updateMetronomeReadout(Number(timeline.value) * 1000);
  if (!previewPlaying) brandOrb.style.animationDuration = "1s";
}

function pulseVisualMetronome(tickInfo: MetronomeTick, rate: number): void {
  if (!metronomeEnabled.checked) return;
  visualMetronomeSide *= -1;
  const next = previewTicksQueue[visualMetronomeIndex];
  const beatSec = next ? Math.max(.08, (next.timeMs - tickInfo.timeMs) / 1000 / Math.max(.01, rate)) : .35;
  metronomeStick.style.transitionDuration = `${clamp(beatSec * .82, .09, 1.35).toFixed(3)}s`;
  metronomeStick.style.transform = `translateX(-50%) rotate(${visualMetronomeSide * 25}deg)`;

  metronomeModel.classList.remove("metronome-pulse", "metronome-accent");
  // Force the CSS pulse animation to restart even on consecutive fast beats.
  void metronomeModel.offsetWidth;
  metronomeModel.classList.add("metronome-pulse");
  if (tickInfo.accent) metronomeModel.classList.add("metronome-accent");
  metronomeBeatLabel.textContent = tickInfo.accent ? `downbeat · ${tickInfo.beat + 1}/${tickInfo.meter}` : `beat ${tickInfo.beat + 1}/${tickInfo.meter}`;
  renderMeterBar(tickInfo.meter, tickInfo.beat);
  updateMetronomeReadout(tickInfo.timeMs);

  window.clearTimeout(visualMetronomePulseTimer);
  visualMetronomePulseTimer = window.setTimeout(() => {
    metronomeModel.classList.remove("metronome-pulse", "metronome-accent");
    metronomeBeatLabel.textContent = previewPlaying ? "running" : "ready";
  }, 360);
}

function updateVisualMetronome(nowMs: number, rate: number): void {
  if (!metronomeEnabled.checked || !previewPlaying) return;
  let latest: MetronomeTick | undefined;
  while (visualMetronomeIndex < previewTicksQueue.length && previewTicksQueue[visualMetronomeIndex].timeMs <= nowMs + 10 * rate)
    latest = previewTicksQueue[visualMetronomeIndex++];
  // A delayed frame updates once instead of forcing a layout for every missed beat.
  if (latest) pulseVisualMetronome(latest, rate);
}

function refreshMetronomeUi(): void {
  metronomeSource.disabled = !metronomeEnabled.checked;
  metronomeModel.classList.toggle("is-disabled", !metronomeEnabled.checked);
  if (!metronomeEnabled.checked) resetVisualMetronome();
  else updateMetronomeReadout(Number(timeline.value) * 1000);
}

timeline.oninput = () => {
  setPosition(Number(timeline.value));
  if (previewPlaying) void startPreview(Number(timeline.value));
};
window.addEventListener("resize", () => { drawWaveform(); drawNotePreview(); });

resnap.onchange = () => { invalidatePreviewAudio(); drawNotePreview(); previewSettingsChanged(); };
snapTolerance.oninput = () => { stopPreview(); invalidatePreviewAudio(); drawNotePreview(); scheduleTimingPreview(); };
resnapMode.onchange = () => { invalidatePreviewAudio(); drawNotePreview(); previewSettingsChanged(); };
previewMode.onchange = previewSettingsChanged;
metronomeEnabled.onchange = () => { refreshMetronomeUi(); if (previewPlaying) void startPreview(Number(timeline.value)); };
metronomeSource.onchange = () => { if (previewPlaying) void startPreview(Number(timeline.value)); };
playbackRate.onchange = previewSettingsChanged;
hitsoundVolume.oninput = refreshVolumeLabels;
audioVolume.oninput = refreshVolumeLabels;
oggQuality.oninput = refreshVolumeLabels;
sampleFormat.onchange = refreshSampleFormatUi;
notePreviewMode.onchange = drawNotePreview;
notePreviewSpeed.oninput = () => { const speed = clamp(Number(notePreviewSpeed.value) || 28, 1, 40); notePreviewSpeedOut.value = `${Math.round(speed)} · ${Math.round(11480 / speed)}ms`; drawNotePreview(); };
keysInput.oninput = () => {
  const min = Math.min(MAX_OUTPUT_KEYS, Math.max(1, state.requiredKeys || 1));
  const value = clamp(Math.round(Number(keysInput.value) || min), min, MAX_OUTPUT_KEYS);
  keysInput.value = String(value);
  invalidateConvertedPlacement();
  drawNotePreview();
};

btnLoad.onclick = async () => {
  if (chartSelectionBusy) return;
  chartSelectionBusy = true; btnBms.disabled = true; btnOsu.disabled = true; refreshChartSelectors();
  if (!(state.bmsPath && state.osuPath)) { await loadStandalonePreview(); return; }
  state.standaloneKind = null;
  setStandaloneControls(false);
  showPreviewLoading("analysis", "Analyzing samples and synchronizing timing…");
  try {
  state.analyzedReuseKey = "";
  audioCtx ??= new AudioContext();
  stopPreview();
  btnLoad.disabled = true;
  btnConvert.disabled = true;
  btnPlay.disabled = true;
  state.sync = null;
  manualSync.value = "0";
  invalidatePreviewAudio();
  state.audioBuffers.clear();
  state.targetAudioBuffer = null;
  state.stretchedTargetBuffers.clear();
  state.stretchedSampleBuffers.clear();
  state.convertedMixBuffer = null;
  state.referenceMixBuffer = null;
  state.tempoMixBuffers.clear();
  state.requiredKeys = 1;
  state.compatibilityOk = false;
  state.syncedBmsBeatTimes = [];
  appendLog("Parsing BMS and target osu! metadata…");

  const data = await window.bms2osu.parseMapData(state.bmsPath, state.osuPath) as {
    notes: Note[];
    files: Record<string, string>;
    osuAudioPath: string | null;
    timingPoints: TimingPoint[];
    bmsBeatTimes: number[];
    scrollPoints?: { timeMs: number; multiplier: number }[];
    metadata: { bms: { title: string; artist: string }; osu: { title: string; artist: string; creator: string; version: string } };
    osuPreview: { mode: number; keys: number; notes: TargetPreviewNote[] };
    reuseKey: string;
  } | null;
  if (!data) {
    appendLog("[ERROR] Could not parse maps.");
    btnLoad.disabled = false;
    return;
  }
  state.files = data.files;
  state.referenceEvents = data.notes;
  state.timingPoints = data.timingPoints ?? [];
  state.scrollPoints = data.scrollPoints ?? [];
  state.bmsBeatTimes = data.bmsBeatTimes ?? [];
  state.targetMode = data.osuPreview?.mode ?? 0;
  state.targetKeys = data.osuPreview?.keys ?? 4;
  state.targetNotes = data.osuPreview?.notes ?? [];
  state.metadata = data.metadata ?? { bms: { title: "", artist: "" }, osu: { title: "", artist: "", creator: "", version: "" } };
  state.targetAnchorTimes = [];
  for (const note of state.targetNotes) {
    if (!state.targetAnchorTimes.length || state.targetAnchorTimes[state.targetAnchorTimes.length - 1] !== note.timeMs) state.targetAnchorTimes.push(note.timeMs);
  }
  if (state.targetMode === 3) appendLog(`Target note preview: ${state.targetKeys}K, ${state.targetNotes.length} hitobjects parsed.`);
  else appendLog(`[WARN] Target .osu Mode is ${state.targetMode}; target mania note preview is unavailable.`);

  if (!data.osuAudioPath) {
    appendLog("[ERROR] Target .osu AudioFilename is unavailable.");
    btnLoad.disabled = false;
    return;
  }

  try {
    const bytes = await window.bms2osu.readAudioFile(data.osuAudioPath);
    if (!bytes?.length) throw new Error("empty audio");
    state.targetAudioBuffer = await audioCtx.decodeAudioData(bytesToArrayBuffer(bytes));
  } catch (e) {
    appendLog(`[ERROR] Target audio decode failed: ${e instanceof Error ? e.message : String(e)}`);
    btnLoad.disabled = false;
    return;
  }

  appendLog(`Target audio decoded: ${formatTime(state.targetAudioBuffer.duration)}; ${state.timingPoints.length} red timing points found.`);
  let silent = 0;
  let failed = 0;
  for (const [id, filePath] of Object.entries(data.files)) {
    try {
      const bytes = await window.bms2osu.readAudioFile(filePath);
      if (!bytes?.length) continue;
      const b = await audioCtx.decodeAudioData(bytesToArrayBuffer(bytes));
      let peak = 0;
      for (let c = 0; c < b.numberOfChannels; c++) {
        const d = b.getChannelData(c);
        const stride = Math.max(1, Math.floor(d.length / 20000));
        for (let i = 0; i < d.length; i += stride) peak = Math.max(peak, Math.abs(d[i]));
      }
      if (peak < .001) silent++;
      else state.audioBuffers.set(id, analyseBuffer(b));
    } catch {
      failed++;
    }
  }

  const usable = state.referenceEvents.filter(e => state.audioBuffers.has(e.wavId));
  appendLog(`Usable BMS audio events: ${usable.length}; silent samples: ${silent}${failed ? `; decode failures: ${failed}` : ""}.`);
  if (usable.length < 4) {
    appendLog("[ERROR] Too few usable events for synchronization.");
    btnLoad.disabled = false;
    return;
  }

  try {
    state.sync = synchronizeBmsToOsu(usable, state.audioBuffers, state.targetAudioBuffer);
    appendLog(describeSync(state.sync));
    for (const candidate of state.sync.alternatives ?? []) appendLog(`Sync evidence ${candidate.method}: confidence ${candidate.confidence.toFixed(3)}, residual ${candidate.residualMs.toFixed(2)} ms`);
  } catch (e) {
    appendLog(`[ERROR] Synchronization failed: ${e instanceof Error ? e.message : String(e)}`);
    btnLoad.disabled = false;
    return;
  }

  state.syncedEvents = usable.map(n => ({ ...n, sourceTimeMs: n.timeMs, timeMs: mapBmsTime(n.timeMs, state.sync!) }));
  invalidatePreviewAudio();
  state.syncedBmsBeatTimes = state.bmsBeatTimes.map(t => mapBmsTime(t, state.sync!));
  const noteEnd = state.syncedEvents.length ? Math.max(...state.syncedEvents.map(n => n.timeMs)) : 0;
  const targetNoteEnd = state.targetNotes.length ? Math.max(...state.targetNotes.map(n => n.endTimeMs)) : 0;
  state.songLengthMs = Math.max(state.targetAudioBuffer.duration * 1000, noteEnd, targetNoteEnd);
  rebuildPhaseBeatLocks();

  const compatibility = assessPairCompatibility(state.sync);
  appendLog(compatibility.summary);
  for (const reason of compatibility.reasons) appendLog(`[PAIR CHECK] ${reason}`);

  if (compatibility.level === "fail") {
    const detail = [
      "Why it was blocked:",
      ...compatibility.reasons.map(r => `• ${r}`),
      "",
      "Measured checks:",
      ...compatibility.metrics.map(m => `• ${m}`),
      "",
      `BMS: ${state.metadata.bms.artist || "?"} - ${state.metadata.bms.title || "?"}`,
      `osu!: ${state.metadata.osu.artist || "?"} - ${state.metadata.osu.title || "?"} [${state.metadata.osu.version || "?"}]`,
    ].join("\n");
    await window.bms2osu.showPairCheckDialog({
      kind: "error",
      title: "BMS / osu! pair verification failed",
      message: "The selected BMS and .osu look clearly incompatible, so preview and conversion were blocked.",
      detail,
      allowContinue: false,
    });
    appendLog("[ERROR] Pair verification found strong multi-signal evidence of a mismatched song.");
    statusEl.textContent = "Pair verification failed — see the popup and diagnostics for the exact checks.";
    state.compatibilityOk = false;
    state.sync = null;
    state.syncedEvents = [];
    state.syncedBmsBeatTimes = [];
    timeline.disabled = true;
    btnPlay.disabled = true;
    btnConvert.disabled = true;
    btnLoad.disabled = false;
    drawWaveform();
    drawNotePreview();
    return;
  }

  if (compatibility.level === "warning") {
    const detail = [
      "The checker could not verify this pair confidently, but it also did not find enough evidence to call it wrong.",
      "",
      "Weak / uncertain checks:",
      ...compatibility.reasons.map(r => `• ${r}`),
      "",
      "Measured checks:",
      ...compatibility.metrics.map(m => `• ${m}`),
      "",
      "If you know these files belong to the same song, choose Continue anyway. The audio synchronizer remains authoritative.",
    ].join("\n");
    const continueAnyway = await window.bms2osu.showPairCheckDialog({
      kind: "warning",
      title: "BMS / osu! pair could not be fully verified",
      message: "This pair is plausible, but some verification signals are weak.",
      detail,
      allowContinue: true,
    });
    if (!continueAnyway) {
      appendLog("Pair verification was uncertain and the user cancelled analysis.");
      statusEl.textContent = "Pair verification uncertain — analysis cancelled by user.";
      state.compatibilityOk = false;
      state.sync = null;
      state.syncedEvents = [];
      state.syncedBmsBeatTimes = [];
      timeline.disabled = true;
      btnPlay.disabled = true;
      btnConvert.disabled = true;
      btnLoad.disabled = false;
      drawWaveform();
      drawNotePreview();
      return;
    }
    appendLog("Pair verification override accepted by user; continuing with measured audio synchronization.");
  } else {
    appendLog("Pair verification passed.");
  }

  state.compatibilityOk = true;
  state.analyzedReuseKey = data.reuseKey;
  // Start audio work before the final canvas/layout work.
  void warmPreview();
  updateAutoKeyBounds();
  fileSummaryBms.textContent = `${state.bmsPath.split(/[\\/]/).pop() || state.bmsPath} · ${state.syncedEvents.length} audible events`;
  fileSummaryOsu.textContent = `${state.osuPath.split(/[\\/]/).pop() || state.osuPath} · ${state.targetKeys}K · ${state.targetNotes.length} objects`;
  timeline.max = String(state.songLengthMs / 1000);
  timeline.disabled = false;
  setPosition(0);
  timeTotal.textContent = formatTime(state.songLengthMs / 1000);
  drawWaveform();
  statusEl.textContent = `Synchronized ${state.syncedEvents.length} audible BMS events. Target osu audio remains the default preview reference; BMS-native metronome is available as an alternate check.`;
  btnConvert.disabled = false;
  btnLoad.disabled = false;
  } finally {
    chartSelectionBusy = false; btnBms.disabled = false; btnOsu.disabled = false; refreshChartSelectors();
    if (previewLoadingKey === "analysis") {
      previewLoading.hidden = true; previewLoadingKey = null;
      noteCanvas.setAttribute("aria-busy", "false");
    }
  }
};

/* ------------------------------------------------------------------ */
/* Preview transport                                                   */
/* ------------------------------------------------------------------ */
let targetSource: AudioBufferSourceNode | null = null;
let keyBusSource: AudioBufferSourceNode | null = null;
let keySources: AudioBufferSourceNode[] = [];
let metronomeSources: AudioBufferSourceNode[] = [];
let activeMasterGain: GainNode | null = null;
let activeTargetGain: GainNode | null = null;
let activeSampleGain: GainNode | null = null;
let previewTimer = 0;
let previewAudioTimer = 0;
let previewStartedAt = 0;
let previewStartSec = 0;
let previewPlaying = false;
let previewEventsQueue: Note[] = [];
let previewEventIndex = 0;
let previewTicksQueue: MetronomeTick[] = [];
let previewTickIndex = 0;
let previewScheduledUntilSec = 0;
let metronomeBeatBuffer: AudioBuffer | null = null;
let metronomeAccentBuffer: AudioBuffer | null = null;
const PREVIEW_LOOKAHEAD_SEC = 7;
const PREVIEW_START_LEAD_SEC = .05;

function timeStretchWsola(input: AudioBuffer, rate: number): AudioBuffer {
  if (!audioCtx || Math.abs(rate - 1) < 1e-6) return input;
  const sr = input.sampleRate;
  // Approximate osu!framework/BASS_FX editor settings for the no-FFmpeg fallback:
  // 30 ms sequence + 4 ms overlap, with a small seek window.
  const frame = Math.max(512, Math.round(sr * .030));
  const overlap = Math.max(64, Math.round(sr * .004));
  const synthesisHop = Math.max(128, frame - overlap);
  const analysisHop = synthesisHop * rate;
  const search = Math.max(64, Math.round(sr * .012));
  const searchStep = Math.max(4, Math.round(sr / 3000));
  const outLength = Math.max(frame, Math.ceil(input.length / rate) + frame);
  const output = audioCtx.createBuffer(input.numberOfChannels, outLength, sr);

  // Correlation uses a lightweight mono view so stereo channels share exactly
  // the same selected grain positions and do not smear against each other.
  const mono = new Float32Array(input.length);
  for (let c = 0; c < input.numberOfChannels; c++) {
    const d = input.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / input.numberOfChannels;
  }

  let prevIn = 0;
  let outPos = 0;
  for (let c = 0; c < input.numberOfChannels; c++) {
    const src = input.getChannelData(c);
    const dst = output.getChannelData(c);
    dst.set(src.subarray(0, Math.min(frame, src.length)), 0);
  }
  outPos += synthesisHop;

  while (outPos + frame < outLength) {
    const predicted = Math.round(prevIn + analysisHop);
    if (predicted >= input.length - frame) break;
    const searchLo = Math.max(0, predicted - search);
    const searchHi = Math.min(input.length - frame - 1, predicted + search);
    let bestIn = predicted;
    let bestScore = Number.NEGATIVE_INFINITY;

    // Compare the previous source grain tail with each candidate head.
    const prevTail = prevIn + synthesisHop;
    for (let candidate = searchLo; candidate <= searchHi; candidate += searchStep) {
      let dot = 0, aa = 0, bb = 0;
      const stride = 8;
      for (let i = 0; i < overlap; i += stride) {
        const a = mono[prevTail + i] ?? 0;
        const b = mono[candidate + i] ?? 0;
        dot += a * b; aa += a * a; bb += b * b;
      }
      const score = dot / Math.sqrt(Math.max(1e-12, aa * bb));
      if (score > bestScore) { bestScore = score; bestIn = candidate; }
    }

    for (let c = 0; c < input.numberOfChannels; c++) {
      const src = input.getChannelData(c);
      const dst = output.getChannelData(c);
      const available = Math.min(frame, src.length - bestIn, dst.length - outPos);
      const ov = Math.min(overlap, available);
      for (let i = 0; i < ov; i++) {
        const a = (i + 1) / (ov + 1);
        dst[outPos + i] = dst[outPos + i] * (1 - a) + src[bestIn + i] * a;
      }
      for (let i = ov; i < available; i++) dst[outPos + i] = src[bestIn + i];
    }
    prevIn = bestIn;
    outPos += synthesisHop;
  }

  // Trim the work padding while keeping the expected stretched duration.
  const wanted = Math.max(1, Math.ceil(input.length / rate));
  const trimmed = audioCtx.createBuffer(output.numberOfChannels, wanted, sr);
  for (let c = 0; c < output.numberOfChannels; c++) trimmed.copyToChannel(output.getChannelData(c).subarray(0, wanted), c);
  return trimmed;
}

const previewWavBytes = new WeakMap<AudioBuffer, Uint8Array>();
function audioBufferToWavBytes(buffer: AudioBuffer): Uint8Array {
  const cached = previewWavBytes.get(buffer);
  if (cached) return cached;
  const channels = Math.min(2, Math.max(1, buffer.numberOfChannels));
  const frames = buffer.length;
  const bytes = new Uint8Array(44 + frames * channels * 2);
  const view = new DataView(bytes.buffer);
  const write = (off: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(off + i, text.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); write(8, "WAVE");
  write(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, channels, true); view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true); view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true); write(36, "data"); view.setUint32(40, frames * channels * 2, true);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = clamp(buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1))[i] || 0, -1, 1);
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  previewWavBytes.set(buffer, bytes);
  return bytes;
}

async function renderEventBus(events: Note[]): Promise<AudioBuffer | null> {
  if (!audioCtx || !state.targetAudioBuffer || !events.length) return null;
  const sr = state.targetAudioBuffer.sampleRate;
  const frames = Math.max(1, Math.ceil((state.songLengthMs / 1000 + 1) * sr));
  const generation = preparationGeneration;
  const output = audioCtx.createBuffer(2, frames, sr);
  const started = performance.now();
  const decoded = new Map<string, AudioBuffer>();
  let cachedBytes = 0;
  let decodeCount = 0;
  const cacheLimit = 32 * 1024 * 1024;
  appendLog(`Preparing BMS preview: ${events.length} events, ${Math.ceil(frames / sr)} seconds…`);
  // Batch sample PCM at 32 MiB (or one larger sample) inside ten-second windows.
  // A separate temporary 32 MiB LRU avoids re-decoding common samples.
  // Only the song bus persists after this function returns.
  for (let start = 0; start < frames; start += sr * 10) {
    const count = Math.min(sr * 10, frames - start);
    if (generation !== preparationGeneration) throw new Error("Preview inputs changed");
    if (previewLoadingKey === preparationKey(previewMode.value as PreviewMode, currentRate())) previewLoadingMessage.textContent = `Audio prepared: ${Math.floor(start / sr)} / ${Math.ceil(frames / sr)} s of song · elapsed ${((performance.now() - started) / 1000).toFixed(1)} s`;
    if (start === 0 || Math.floor(start / sr) % 30 === 0) appendLog(`Audio prepared: ${Math.floor(start / sr)} / ${Math.ceil(frames / sr)} s of song · elapsed ${((performance.now() - started) / 1000).toFixed(1)} s`);
    let offline = new OfflineAudioContext(2, count, sr);
    const mix = audioCtx.createBuffer(2, count, sr);
    let batchBytes = 0;
    let scheduled = 0;
    const flush = async () => {
      if (!scheduled) return;
      const chunk = await offline.startRendering();
      for (let c = 0; c < 2; c++) {
        const dst = mix.getChannelData(c), src = chunk.getChannelData(c);
        for (let i = 0; i < count; i++) dst[i] += src[i];
      }
      offline = new OfflineAudioContext(2, count, sr);
      scheduled = 0; batchBytes = 0;
    };
    const protectedContext = new OfflineAudioContext(2, count, sr);
    const bus = protectedContext.createGain();
    bus.gain.value = 0.8;
    const protection = protectedContext.createWaveShaper();
    protection.curve = Float32Array.from({ length: 65537 }, (_, i) => {
      const x = i / 32768 - 1;
      const a = Math.abs(x);
      return Math.sign(x) * (a <= .8 ? a : .8 + .17 * (1 - Math.exp(-(a - .8) / .17)));
    });
    bus.connect(protection); protection.connect(protectedContext.destination);
    const grouped = new Map<string, Note[]>();
    for (const event of events) {
      const sample = state.audioBuffers.get(event.wavId);
      if (!sample || event.timeMs >= (start + count) / sr * 1000 || event.timeMs + sample.durationMs <= start / sr * 1000) continue;
      const group = grouped.get(event.wavId) ?? []; group.push(event); grouped.set(event.wavId, group);
    }
    for (const [id, group] of grouped) {
      const size = state.audioBuffers.get(id)!.pcmBytes;
      if (batchBytes + size > 32 * 1024 * 1024) await flush();
      batchBytes += size;
      let buffer = decoded.get(id);
      if (buffer) { decoded.delete(id); decoded.set(id, buffer); }
      else {
        const bytes = await window.bms2osu.readAudioFile(state.files[id]);
        if (!bytes?.length) throw new Error('Preview sample unavailable: ' + id);
        buffer = await audioCtx.decodeAudioData(bytesToArrayBuffer(bytes));
        decodeCount++;
        const actualBytes = buffer.length * buffer.numberOfChannels * 4;
        if (actualBytes <= cacheLimit) {
          while (cachedBytes + actualBytes > cacheLimit && decoded.size) {
            const oldest = decoded.keys().next().value!;
            const removed = decoded.get(oldest)!;
            cachedBytes -= removed.length * removed.numberOfChannels * 4;
            decoded.delete(oldest);
          }
          decoded.set(id, buffer); cachedBytes += actualBytes;
        }
      }
      if (generation !== preparationGeneration) throw new Error('Preview inputs changed');
      for (const event of group) {
        const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination);
        const relative = event.timeMs / 1000 - start / sr;
        source.start(Math.max(0, relative), Math.max(0, -relative)); scheduled++;
      }
    }
    await flush();
    {
      const source = protectedContext.createBufferSource();
      source.buffer = mix; source.connect(bus); source.start();
      const chunk = await protectedContext.startRendering();
      if (generation !== preparationGeneration) throw new Error('Preview inputs changed');
      for (let c = 0; c < 2; c++) output.getChannelData(c).set(chunk.getChannelData(c), start);
    }
  }
  appendLog(`BMS preview ready in ${((performance.now() - started) / 1000).toFixed(2)} s; ${decodeCount} sample decodes; temporary cache ${(cachedBytes / 1048576).toFixed(1)} MiB.`);
  return output;
}

async function previewMixBuffer(mode: PreviewMode): Promise<AudioBuffer | null> {
  const generation = preparationGeneration;
  if (mode === "target-only") return null;
  if (mode === "bms-reference") {
    if (!state.referenceMixBuffer) {
      const buffer = await renderEventBus(state.syncedEvents);
      if (generation !== preparationGeneration) return null;
      state.referenceMixBuffer = buffer;
    }
    return state.referenceMixBuffer;
  }
  if (!state.convertedMixBuffer) {
    const buffer = await renderEventBus(outputEvents());
    if (generation !== preparationGeneration) return null;
    state.convertedMixBuffer = buffer;
  }
  return state.convertedMixBuffer;
}

async function tempoProcessedBuffer(input: AudioBuffer, rate: number, cacheKey: string): Promise<AudioBuffer | null> {
  if (!audioCtx || Math.abs(rate - 1) < 1e-6) return input;
  const key = `${cacheKey}@${rate.toFixed(3)}`;
  const cached = cacheKey === "target"
    ? state.stretchedTargetBuffers.get(Number(rate.toFixed(3)))
    : state.tempoMixBuffers.get(key);
  if (cached) return cached;

  const generation = preparationGeneration;
  try {
    const wav = audioBufferToWavBytes(input);
    const result = await window.bms2osu.tempoAudio(wav, rate);
    if (result?.ok && result.bytes?.length) {
      const decoded = await audioCtx.decodeAudioData(bytesToArrayBuffer(result.bytes));
      if (generation !== preparationGeneration) return null;
      if (cacheKey === "target") {
        state.stretchedTargetBuffers.set(Number(rate.toFixed(3)), decoded);
      } else state.tempoMixBuffers.set(key, decoded);
      appendLog(`Prepared ${rate.toFixed(2)}× tempo-only preview with FFmpeg atempo (${cacheKey}).`);
      return decoded;
    }
    appendLog(`[ERROR] Tempo preview backend unavailable${result?.error ? `: ${result.error}` : ""}.`);
  } catch (error) {
    appendLog(`[ERROR] FFmpeg tempo preview failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  return null;
}

async function tempoProcessedPairBuffer(target: AudioBuffer, hitsounds: AudioBuffer, rate: number, cacheKey = "converted"): Promise<AudioBuffer | null> {
  if (!audioCtx) return null;
  const key = `pair-${cacheKey}@${rate.toFixed(3)}`;
  const cached = state.tempoMixBuffers.get(key);
  if (cached) return cached;
  if (Math.abs(rate - 1) < 1e-6) return null;
  const generation = preparationGeneration;
  try {
    const result = await window.bms2osu.tempoPair(audioBufferToWavBytes(target), audioBufferToWavBytes(hitsounds), rate);
    if (result?.ok && result.bytes?.length) {
      const decoded = await audioCtx.decodeAudioData(bytesToArrayBuffer(result.bytes));
      if (generation !== preparationGeneration) return null;
      if (decoded.numberOfChannels >= 4) {
        state.tempoMixBuffers.set(key, decoded);
        appendLog(`Prepared ${rate.toFixed(2)}× aligned 4-channel tempo preview (song + BMS bus share one time warp).`);
        return decoded;
      }
      appendLog(`[WARN] Tempo backend returned ${decoded.numberOfChannels} channels instead of 4; using the aligned in-process fallback.`);
    }
    appendLog(`[ERROR] Aligned paired tempo backend unavailable${result?.error ? `: ${result.error}` : ""}.`);
  } catch (error) {
    appendLog(`[ERROR] Paired tempo preview failed: ${error instanceof Error ? error.message : String(error)}.`);
  }

  return null;
}

const stretchedMetronomeBuffers = new Map<string, AudioBuffer>();
function pitchPreservedMetronomeBuffer(input: AudioBuffer, rate: number, accent: boolean): AudioBuffer {
  if (Math.abs(rate - 1) < 1e-6) return input;
  const key = `${accent ? "a" : "b"}@${rate.toFixed(3)}`;
  const cached = stretchedMetronomeBuffers.get(key);
  if (cached) return cached;
  const output = timeStretchWsola(input, rate);
  stretchedMetronomeBuffers.set(key, output);
  return output;
}

function refreshTransportButton(preparing = false): void {
  btnPlay.textContent = previewPlaying ? "Ⅱ" : "▶";
  const label = previewPlaying ? "Pause preview" : preparing ? "Preparing audio…" : "Play preview";
  btnPlay.title = label; btnPlay.setAttribute("aria-label", label);
  btnPlay.classList.toggle("transport-active", previewPlaying);
  btnPlay.disabled = !previewPlaying && (preparing || !state.targetAudioBuffer || !state.compatibilityOk);
}
function stopPreview(): void {
  transportRequest++;
  if (targetSource) try { targetSource.stop(); } catch {}
  if (keyBusSource) try { keyBusSource.stop(); } catch {}
  for (const s of keySources) try { s.stop(); } catch {}
  for (const s of metronomeSources) try { s.stop(); } catch {}
  targetSource = null;
  keyBusSource = null;
  keySources = [];
  metronomeSources = [];
  previewEventsQueue = [];
  previewTicksQueue = [];
  previewEventIndex = 0;
  previewTickIndex = 0;
  previewScheduledUntilSec = 0;
  previewPlaying = false;
  btnPlay.classList.remove("transport-active");
  resetVisualMetronome();
  activeMasterGain = null;
  activeTargetGain = null;
  activeSampleGain = null;
  cancelAnimationFrame(previewTimer);
  window.clearInterval(previewAudioTimer);
  previewAudioTimer = 0;
  refreshTransportButton();
}

// Audio scheduling follows the audio clock independently of canvas redraws.
function advancePreviewAudio(): void {
  if (!previewPlaying || !audioCtx) return;
  const rate = currentRate();
  const sec = previewStartSec + Math.max(0, audioCtx.currentTime - previewStartedAt) * rate;
  const end = state.songLengthMs / 1000;
  if (sec >= end - 1e-4) { stopPreview(); setPosition(end); return; }
  const until = Math.min(end, sec + PREVIEW_LOOKAHEAD_SEC);
  if (until > previewScheduledUntilSec + .25) schedulePreviewUntil(until, rate);
}
function tick(): void {
  if (!previewPlaying || !audioCtx) return;
  advancePreviewAudio();
  if (!previewPlaying) return;
  const rate = currentRate();
  const sec = previewStartSec + Math.max(0, audioCtx.currentTime - previewStartedAt) * rate;
  setPosition(sec);
  updateVisualMetronome(sec * 1000, rate);
  previewTimer = requestAnimationFrame(tick);
}

function shouldPlayTarget(mode: PreviewMode): boolean {
  return mode === "target-plus-keys" || mode === "target-only";
}
function previewSampleEvents(mode: PreviewMode): Note[] {
  if (mode === "target-only") return [];
  if (mode === "bms-reference") return state.syncedEvents;
  return outputEvents();
}

function osuMetronomeTicks(startMs: number, endMs: number, rate = 1): MetronomeTick[] {
  const out: MetronomeTick[] = [];
  // In extreme BPM sections, preserve beat phase but thin inaudibly dense clicks.
  // Limit to 20 clicks per real second without changing chart or audio timing.
  const gap = 50 * rate;
  for (let i = 0; i < state.timingPoints.length; i++) {
    const tp = state.timingPoints[i];
    const segmentEnd = Math.min(endMs, state.timingPoints[i + 1]?.timeMs ?? endMs);
    const from = Math.max(startMs, tp.timeMs, (out.at(-1)?.timeMs ?? -Infinity) + gap);
    if (segmentEnd <= from || !Number.isFinite(tp.beatLength) || tp.beatLength <= 0) continue;
    const stride = Math.max(1, Math.ceil(gap / tp.beatLength));
    const first = Math.max(0, Math.ceil((from - tp.timeMs - 1e-7) / tp.beatLength));
    const count = Math.min(Math.ceil((segmentEnd - from) / gap) + 1, Math.ceil((segmentEnd - tp.timeMs - first * tp.beatLength) / (stride * tp.beatLength)));
    for (let n = 0; n < count; n++) {
      const index = first + n * stride, t = tp.timeMs + index * tp.beatLength;
      if (!Number.isFinite(t) || t >= segmentEnd - 1e-7 || t < from - 1e-7) continue;
      const meter = Math.max(1, tp.meter || 4), beat = index % meter;
      out.push({ timeMs: t, accent: beat === 0, beat, meter });
    }
  }
  return out;
}
function bmsMetronomeTicks(startMs: number, endMs: number, rate = 1): MetronomeTick[] {
  const out: MetronomeTick[] = [];
  let last = -Infinity;
  for (let i = 0; i < state.syncedBmsBeatTimes.length; i++) {
    const t = state.syncedBmsBeatTimes[i];
    if (t < startMs || t < last + 50 * rate) continue;
    if (t >= endMs) break;
    if (!Number.isFinite(t)) continue;
    const beat = i % 4;
    out.push({ timeMs: t, accent: beat === 0, beat, meter: 4 }); last = t;
  }
  return out;
}

/** Create a short osu!-style editor click in memory. Using an AudioBufferSource
 * is considerably more reliable in Electron than creating thousands of live
 * oscillators, and playbackRate naturally lowers both click speed and pitch. */
function ensureMetronomeBuffers(): void {
  if (!audioCtx || (metronomeBeatBuffer && metronomeAccentBuffer)) return;
  const makeClick = (frequency: number): AudioBuffer => {
    const duration = .045;
    const frames = Math.max(1, Math.ceil(audioCtx!.sampleRate * duration));
    const buffer = audioCtx!.createBuffer(1, frames, audioCtx!.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      const t = i / audioCtx!.sampleRate;
      const envelope = Math.exp(-t * 72);
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const harmonic = Math.sin(2 * Math.PI * frequency * 2.03 * t) * .28;
      data[i] = (fundamental + harmonic) * envelope * .72;
    }
    return buffer;
  };
  metronomeBeatBuffer = makeClick(1050);
  metronomeAccentBuffer = makeClick(1550);
}

function scheduleMetronomeTick(tick: MetronomeTick, rate: number): void {
  if (!audioCtx || !metronomeEnabled.checked) return;
  ensureMetronomeBuffers();
  const rawBuffer = tick.accent ? metronomeAccentBuffer : metronomeBeatBuffer;
  if (!rawBuffer) return;
  const buffer = rawBuffer;
  const when = previewStartedAt + ((tick.timeMs / 1000) - previewStartSec) / rate;
  if (when < audioCtx.currentTime - .02) return;
  const source = audioCtx.createBufferSource();
  const gain = audioCtx.createGain();
  source.buffer = buffer;
  // Timing is slowed by scheduling, but the click itself keeps its original pitch.
  source.playbackRate.value = 1;
  gain.gain.value = tick.accent ? .42 : .28;
  source.connect(gain);
  gain.connect(activeMasterGain ?? audioCtx.destination);
  source.start(Math.max(when, audioCtx.currentTime + .002));
  source.onended = () => {
    try { source.disconnect(); } catch {}
    try { gain.disconnect(); } catch {}
    const index = metronomeSources.indexOf(source);
    if (index >= 0) metronomeSources.splice(index, 1);
  };
  metronomeSources.push(source);
}

function schedulePreviewUntil(endSec: number, rate: number): void {
  if (!audioCtx) return;
  while (previewTickIndex < previewTicksQueue.length) {
    const tick = previewTicksQueue[previewTickIndex];
    if (tick.timeMs / 1000 >= endSec) break;
    previewTickIndex++;
    scheduleMetronomeTick(tick, rate);
  }
  previewScheduledUntilSec = Math.max(previewScheduledUntilSec, endSec);
}


type PreparedPreview = { pairedPreview: AudioBuffer | null; targetPreview: AudioBuffer | null; mixPreview: AudioBuffer | null };
const preparedPreviews = new Map<string, PreparedPreview>();
const pendingPreviews = new Map<string, Promise<PreparedPreview>>();
let transportRequest = 0;
function preparationKey(mode: PreviewMode, rate: number): string {
  return preparationGeneration + ":" + mode + "@" + rate.toFixed(3);
}
function preparePreview(mode: PreviewMode, rate: number): Promise<PreparedPreview> {
  const key = preparationKey(mode, rate);
  const cached = preparedPreviews.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingPreviews.get(key);
  if (pending) return pending;
  const generation = preparationGeneration;
  const job = (async () => {
    if (!audioCtx || !state.targetAudioBuffer) throw new Error("No analyzed audio");
  const [rawMix, independentTarget] = await Promise.all([
    previewMixBuffer(mode),
    mode !== "target-plus-keys" && shouldPlayTarget(mode)
      ? tempoProcessedBuffer(state.targetAudioBuffer, rate, "target")
      : Promise.resolve(null),
  ]);
  if (generation !== preparationGeneration) throw new Error("Preview inputs changed");
  let pairedPreview: AudioBuffer | null = null;
  let targetPreview: AudioBuffer | null = null;
  let mixPreview: AudioBuffer | null = null;

  if (mode === "target-plus-keys" && rawMix && Math.abs(rate - 1) > 1e-6) {
    // Process both layers in one multichannel tempo stream. This is the closest
    // practical equivalent to osu!'s shared tempo clock and prevents the song
    // and keysound bus from receiving different content-dependent warps.
    pairedPreview = await tempoProcessedPairBuffer(state.targetAudioBuffer, rawMix, rate, "converted");
  }
  if (!pairedPreview && !(mode === "target-plus-keys" && rawMix && Math.abs(rate - 1) > 1e-6)) {
    targetPreview = shouldPlayTarget(mode)
      ? independentTarget ?? await tempoProcessedBuffer(state.targetAudioBuffer, rate, "target")
      : null;
    mixPreview = rawMix
      ? await tempoProcessedBuffer(rawMix, rate, mode === "bms-reference" ? "reference" : "converted")
      : null;
  }

  if (Math.abs(rate - 1) > 1e-6) {
    const needsPaired = mode === "target-plus-keys" && !!rawMix;
    const failed = needsPaired
      ? !pairedPreview
      : (shouldPlayTarget(mode) && !targetPreview) || (!!rawMix && !mixPreview);
    if (failed) {
      appendLog("[ERROR] Slow preview could not be prepared with FFmpeg, so playback was cancelled to avoid song/keysound desynchronization.");
      throw new Error("Preview preparation failed");
    }
  }

  return { pairedPreview, targetPreview, mixPreview };

  })().then(result => {
    if (generation !== preparationGeneration) throw new Error("Preview inputs changed");
    preparedPreviews.set(key, result);
    return result;
  }).finally(() => { pendingPreviews.delete(key); });
  pendingPreviews.set(key, job);
  return job;
}
async function warmPreview(): Promise<void> {
  if (!state.compatibilityOk || !state.targetAudioBuffer) return;
  const mode = previewMode.value as PreviewMode;
  const rate = currentRate();
  const key = preparationKey(mode, rate);
  if (preparedPreviews.has(key)) {
    showPreviewLoading(key, "Preview ready");
    finishPreviewLoading(key, true);
    refreshTransportButton();
    return;
  }
  refreshTransportButton(true);
  showPreviewLoading(key, "Preparing synchronized audio and note timing…");
  try {
    await preparePreview(mode, rate);
  } catch (error) {
    if (key === preparationKey(previewMode.value as PreviewMode, currentRate()))
      appendLog("[WARN] " + (error instanceof Error ? error.message : String(error)));
  } finally {
    if (key === preparationKey(previewMode.value as PreviewMode, currentRate())) {
      const ready = preparedPreviews.has(key);
      finishPreviewLoading(key, ready);
      refreshTransportButton();
    }
  }
}
function previewSettingsChanged(): void {
  if (previewPlaying) void startPreview(Number(timeline.value));
  else { stopPreview(); void warmPreview(); }
}
let timingPreviewTimer = 0;
function scheduleTimingPreview(): void {
  window.clearTimeout(timingPreviewTimer);
  timingPreviewTimer = window.setTimeout(previewSettingsChanged, 300);
}

async function startPreview(startSec: number): Promise<void> {
  if (!audioCtx || !state.targetAudioBuffer || !state.compatibilityOk) return;
  stopPreview();
  const request = transportRequest;
  await audioCtx.resume();
  if (request !== transportRequest) return;
  const mode = previewMode.value as PreviewMode;
  const rate = currentRate();
  const songEndSec = state.songLengthMs / 1000;
  startSec = clamp(startSec, 0, songEndSec);
  if (startSec >= songEndSec) return;

  btnPlay.disabled = true;

  const key = preparationKey(mode, rate);
  let prepared = preparedPreviews.get(key);
  if (!prepared) {
    showPreviewLoading(key, "Preparing synchronized audio and note timing…");
    try { prepared = await preparePreview(mode, rate); finishPreviewLoading(key, true); }
    catch { if (request === transportRequest) { finishPreviewLoading(key, false); btnPlay.disabled = false; } return; }
  }
  if (request !== transportRequest || key !== preparationKey(previewMode.value as PreviewMode, currentRate())) return;
  const { pairedPreview, targetPreview, mixPreview } = prepared;

  previewPlaying = true;
  refreshTransportButton();
  previewStartSec = startSec;
  previewStartedAt = audioCtx.currentTime + PREVIEW_START_LEAD_SEC;

  activeMasterGain = audioCtx.createGain();
  activeMasterGain.gain.value = state.standaloneKind ? currentAudioGain() : 1;
  activeMasterGain.connect(audioCtx.destination);
  activeTargetGain = audioCtx.createGain();
  activeTargetGain.gain.value = state.standaloneKind ? 1 : currentAudioGain();
  activeTargetGain.connect(activeMasterGain);
  activeSampleGain = audioCtx.createGain();
  activeSampleGain.gain.value = currentHitsoundGain();
  activeSampleGain.connect(activeMasterGain);

  const stretchedOffset = Math.max(0, startSec / rate);
  if (pairedPreview && pairedPreview.numberOfChannels >= 4 && stretchedOffset < pairedPreview.duration) {
    targetSource = audioCtx.createBufferSource();
    targetSource.buffer = pairedPreview;
    const splitter = audioCtx.createChannelSplitter(4);
    const targetMerger = audioCtx.createChannelMerger(2);
    const sampleMerger = audioCtx.createChannelMerger(2);
    targetSource.connect(splitter);
    splitter.connect(targetMerger, 0, 0);
    splitter.connect(targetMerger, 1, 1);
    splitter.connect(sampleMerger, 2, 0);
    splitter.connect(sampleMerger, 3, 1);
    targetMerger.connect(activeTargetGain);
    sampleMerger.connect(activeSampleGain);
    targetSource.start(previewStartedAt, stretchedOffset);
  } else {
    if (targetPreview && stretchedOffset < targetPreview.duration) {
      targetSource = audioCtx.createBufferSource();
      targetSource.buffer = targetPreview;
      targetSource.connect(activeTargetGain);
      targetSource.start(previewStartedAt, stretchedOffset);
    }
    if (mixPreview && stretchedOffset < mixPreview.duration) {
      keyBusSource = audioCtx.createBufferSource();
      keyBusSource.buffer = mixPreview;
      keyBusSource.connect(activeSampleGain);
      keyBusSource.start(previewStartedAt, stretchedOffset);
    }
  }

  // Metronome remains event-scheduled because each click is intentionally a
  // short sample; the song/keysounds are the long-form tempo-processed buses.
  previewEventsQueue = [];
  previewEventIndex = 0;
  previewTicksQueue = metronomeEnabled.checked
    ? ((metronomeSource.value as MetronomeSource) === "bms"
      ? bmsMetronomeTicks(startSec * 1000, state.songLengthMs + 1, rate)
      : osuMetronomeTicks(startSec * 1000, state.songLengthMs + 1, rate))
    : [];
  previewTickIndex = 0;
  visualMetronomeIndex = 0;
  visualMetronomeSide = -1;
  metronomeBeatLabel.textContent = metronomeEnabled.checked ? "running" : "off";
  updateMetronomeReadout(startSec * 1000);
  previewScheduledUntilSec = startSec;
  schedulePreviewUntil(Math.min(songEndSec, startSec + PREVIEW_LOOKAHEAD_SEC), rate);
  previewAudioTimer = window.setInterval(advancePreviewAudio, 50);
  previewTimer = requestAnimationFrame(tick);
}

function togglePreview(): void {
  if (previewPlaying) {
    const sec = audioCtx ? previewStartSec + Math.max(0, audioCtx.currentTime - previewStartedAt) * currentRate() : Number(timeline.value);
    stopPreview(); setPosition(sec);
  } else if (!btnPlay.disabled) void startPreview(Number(timeline.value));
}
btnPlay.onclick = togglePreview;

document.addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName?.toLowerCase();
  const inputType = target instanceof HTMLInputElement ? target.type : "";
  if (tag === "textarea" || target?.isContentEditable || (tag === "input" && ["text", "number"].includes(inputType))) return;
  if (!state.compatibilityOk || !state.targetAudioBuffer) return;
  event.preventDefault();
  togglePreview();
});

/* ------------------------------------------------------------------ */
/* Conversion + sample export                                         */
/* ------------------------------------------------------------------ */
btnConvert.onclick = async () => {
  if (state.standaloneKind || !state.sync || !state.compatibilityOk) {
    appendLog("[ERROR] Analyze and pass the BMS / osu pair verification first.");
    return;
  }

  btnConvert.disabled = true;
  const keys = clamp(Math.round(Number(keysInput.value) || state.requiredKeys || 18), Math.min(MAX_OUTPUT_KEYS, Math.max(1, state.requiredKeys || 1)), MAX_OUTPUT_KEYS);
  const events = outputEvents().sort((a, b) => a.timeMs - b.timeMs);
  const placement = buildConvertedPlacement(keys);
  const usedWavIds = [...new Set(events.map(n => n.wavId))];
  const sampleItems = usedWavIds
    .map(wavId => ({ wavId, sourcePath: state.files[wavId] }))
    .filter(item => !!item.sourcePath);

  const willNeedCompositeMixing = placement.notes.some(n => n.wavIds.length > 1 && n.compositeKey);
  if (sampleFormat.value === "ogg" || willNeedCompositeMixing) {
    const reason = sampleFormat.value === "ogg"
      ? "OGG sample export requires FFmpeg."
      : "This chart needs composite playable keysounds, which require FFmpeg to mix several BMS samples into one hitobject sample.";
    const ffmpeg = await window.bms2osu.ensureFfmpeg(reason);
    if (!ffmpeg?.available) {
      appendLog(`[WARN] Conversion cancelled because FFmpeg is not available. Install it with: ${ffmpeg?.command ?? "winget install --id Gyan.FFmpeg -e"}`);
      btnConvert.disabled = false;
      return;
    }
  }

  appendLog(`Preparing ${sampleItems.length} unique BMS samples for the target beatmap folder…`);
  const sampleResult = await window.bms2osu.prepareSamples(state.osuPath, sampleItems, {
    enabled: true,
    convertToOgg: sampleFormat.value === "ogg",
    oggQuality: Number(oggQuality.value),
    conflict: conflictPolicy.value === "replace" ? "replace" : "skip",
  });

  if (!sampleResult.ok) {
    appendLog(`[ERROR] Sample export failed: ${sampleResult.error ?? "unknown error"}`);
    btnConvert.disabled = false;
    return;
  }
  if (sampleResult.warning) appendLog(`[WARN] ${sampleResult.warning}`);
  appendLog(`Samples ready: ${sampleResult.exported} written${sampleResult.skipped ? `, ${sampleResult.skipped} existing files kept` : ""}.`);

  const compositeItems = placement.notes
    .filter(n => n.wavIds.length > 1 && n.compositeKey)
    .map(n => ({
      key: n.compositeKey!,
      sourcePaths: n.wavIds.map(id => state.files[id]).filter(Boolean),
    }))
    .filter(item => item.sourcePaths.length > 1);
  const uniqueCompositeItems = [...new Map(compositeItems.map(item => [item.key, item])).values()];
  const compositeResult = await window.bms2osu.prepareCompositeSamples(state.osuPath, uniqueCompositeItems, {
    enabled: true,
    convertToOgg: sampleFormat.value === "ogg",
    oggQuality: Number(oggQuality.value),
    conflict: conflictPolicy.value === "replace" ? "replace" : "skip",
  });
  if (!compositeResult.ok) {
    appendLog(`[ERROR] Composite sample export failed: ${compositeResult.error ?? "unknown error"}`);
    btnConvert.disabled = false;
    return;
  }
  if (compositeResult.warning) appendLog(`[WARN] ${compositeResult.warning}`);
  if (uniqueCompositeItems.length) appendLog(`Mixed ${uniqueCompositeItems.length} overflow sample groups into playable composite keysounds; no concurrent duplicate circles are required.`);

  const volume = clamp(Math.round(Number(hitsoundVolume.value) || 100), 1, 100);
  const hitObjects: string[] = [];
  for (const note of placement.notes) {
    const filename = note.wavIds.length > 1 && note.compositeKey
      ? compositeResult.filenames?.[note.compositeKey]
      : sampleResult.filenames?.[note.wavId];
    if (!filename) continue;
    const x = Math.floor(((note.lane + .5) * 512) / keys);
    hitObjects.push(`${x},192,${Math.round(note.timeMs)},1,0,0:0:0:${volume}:${filename}`);
  }

  const shifted = placement.shifted;
  const stacked = placement.stacked;

  appendLog(`Writing ${hitObjects.length} hitobjects at ${volume}% sample volume${resnap.checked ? ` with ${(resnapMode.value as ResnapMode) === "thorough" ? "thorough target/BMS-phase" : "fast target/BMS-phase"} resnap` : ""}.`);
  if (resnap.checked) appendLog(`Resnap result: ${lastSnapStats.target} target-hitobject anchors, ${lastSnapStats.phase} native-structure anchors, ${lastSnapStats.grid} target-grid fallbacks, ${lastSnapStats.unchanged} unchanged.`);
  if (shifted) appendLog(`Lane-shifted ${shifted} keysounds; ${placement.nearShifted} of them avoided same-column reuse inside ${MIN_LANE_REUSE_MS} ms.`);
  if (placement.nearConflicts) appendLog(`[WARN] ${placement.nearConflicts} near-time lane conflicts remained because the chart needs more than ${MAX_OUTPUT_KEYS} playable columns.`);
  if (stacked) appendLog(`${stacked} overflow keysound layers were merged into composite playable samples instead of creating concurrent circles or storyboard sounds.`);

  const removeStoryboardSampleNames: string[] = [
    ...usedWavIds.map(id => state.files[id]).filter((v): v is string => !!v),
    ...(Object.values(sampleResult.filenames ?? {}) as string[]),
    ...(Object.values(compositeResult.filenames ?? {}) as string[]),
  ];
  const result = await window.bms2osu.writeOsuFile(state.osuPath, hitObjects, keys, removeStoryboardSampleNames);
  if (result.ok) appendLog(`=== Conversion finished successfully: ${result.outPath} ===`);
  else appendLog(`[ERROR] Failed to write osu file${result.error ? `: ${result.error}` : "."}`);
  btnConvert.disabled = false;
};

notePreviewSpeedOut.value = `${Math.round(Number(notePreviewSpeed.value))} · ${Math.round(11480 / Math.max(1, Number(notePreviewSpeed.value)))}ms`;
refreshVolumeLabels();
renderMeterBar(4, -1);
updateBrandPulse(0);
refreshMetronomeUi();
refreshSampleFormatUi();
drawWaveform();
drawNotePreview();

const manualSync = $<HTMLInputElement>("manual-sync-ms");
manualSync.oninput = () => {
  if (!state.sync) return;
  const value = Number(manualSync.value);
  if (!manualSync.value.trim() || !Number.isFinite(value) || value === (state.sync.manualCorrectionMs ?? 0)) return;
  stopPreview();
  state.sync.manualCorrectionMs = value;
  state.syncedEvents = state.syncedEvents.map(n => ({ ...n, timeMs: mapBmsTime(n.sourceTimeMs ?? n.timeMs, state.sync!) }));
  state.syncedBmsBeatTimes = state.bmsBeatTimes.map(t => mapBmsTime(t, state.sync!));
  state.referenceMixBuffer = null;
  state.tempoMixBuffers.clear();
  state.songLengthMs = Math.max(state.targetAudioBuffer?.duration ? state.targetAudioBuffer.duration * 1000 : 0,
    state.targetNotes.reduce((end, n) => Math.max(end, n.endTimeMs), 0),
    state.syncedEvents.reduce((end, n) => Math.max(end, n.timeMs + (state.audioBuffers.get(n.wavId)?.durationMs ?? 0)), 0));
  timeline.max = String(state.songLengthMs / 1000);
  invalidatePreviewAudio(); rebuildPhaseBeatLocks(); drawNotePreview();
  appendLog('Manual sync correction: ' + value + ' ms after automatic mapping (positive = later).');
  $("sync-status").textContent = `Manual correction ${value >= 0 ? "+" : ""}${value} ms · automatic alignment retained. Notes updated; preview audio is being prepared.`;
  scheduleTimingPreview();
};
manualSync.onchange = manualSync.oninput;

function setStandaloneControls(single: boolean): void {
  const kind = state.standaloneKind ?? (state.bmsPath && !state.osuPath ? "bms" : "osu");
  $("legend-original").style.background = single && kind === "bms"
    ? "linear-gradient(90deg,#fff0cf 0 33%,#4ce0bd 33% 66%,#ffba66 66%)"
    : "linear-gradient(90deg,#fff 0 33%,#2fc3f3 33% 66%,#ffda32 66%)";
  for (const option of Array.from(metronomeSource.options)) {
    option.hidden = single && option.value !== kind;
    option.disabled = option.hidden;
  }
  if (single) metronomeSource.value = kind;
  $("wave-reference-label").textContent = single ? (kind === "bms" ? "Original BMS audio" : "Original osu!mania song") : "Target osu audio reference";
  previewMode.disabled = single; notePreviewMode.disabled = single;
  const nativeOption = notePreviewMode.querySelector<HTMLOptionElement>('option[value="target"]');
  if (nativeOption) nativeOption.textContent = single ? (kind === "bms" ? "Original BMS chart" : "Original osu!mania chart") : "Target osu! difficulty";
  resnap.disabled = single; snapTolerance.disabled = single; resnapMode.disabled = single; manualSync.disabled = single;
  keysInput.disabled = single;
  if (!single) { keysInput.min = String(Math.min(MAX_OUTPUT_KEYS, Math.max(1, state.requiredKeys))); keysInput.max = String(MAX_OUTPUT_KEYS); }
  hitsoundVolume.disabled = single; audioVolume.disabled = false;
  $("audio-volume-label").textContent = single ? "Master volume" : "Audio volume";
  $("audio-volume-hint").textContent = single ? "all preview audio" : "preview comparison only";
  sampleFormat.disabled = single; oggQuality.disabled = single; conflictPolicy.disabled = single;
  if (single) btnConvert.disabled = true;
}
async function loadStandalonePreview(): Promise<void> {
  const kind = state.bmsPath ? "bms" : "osu";
  const selectedPath = kind === "bms" ? state.bmsPath : state.osuPath;
  if (!selectedPath) return;
  invalidateSelectedPair("Loading original chart…");
  chartSelectionBusy = true; refreshChartSelectors();
  state.standaloneKind = kind; setStandaloneControls(true);
  btnLoad.disabled = true; btnBms.disabled = true; btnOsu.disabled = true;
  $("btn-clear-bms").setAttribute("disabled", ""); $("btn-clear-osu").setAttribute("disabled", "");
  showPreviewLoading("standalone", "Loading original notes…");
  try {
    const chart = await window.bms2osu.readStandaloneChart(selectedPath, kind) as {
      keys: number; notes: TargetPreviewNote[]; events: Note[]; files: Record<string, string>;
      timingPoints: TimingPoint[]; beatTimes: number[]; audioPath: string | null; title: string; warnings: string[];
      viewGrids?: Record<string, { timeMs: number; beat: boolean }[]>;
      scrollPoints?: { timeMs: number; multiplier: number }[];
    };
    state.nativeViewGrids = chart.viewGrids ?? {};
    state.scrollPoints = chart.scrollPoints ?? [];
    state.targetMode = 3; state.targetKeys = chart.keys; state.targetNotes = chart.notes;
    state.timingPoints = chart.timingPoints; state.bmsBeatTimes = chart.beatTimes; state.syncedBmsBeatTimes = chart.beatTimes;
    state.referenceEvents = chart.events; state.syncedEvents = chart.events; state.files = chart.files;
    state.songLengthMs = chart.notes.reduce((end, n) => Math.max(end, n.endTimeMs), 0);
    keysInput.min = String(chart.keys); keysInput.max = String(chart.keys);
    keysInput.value = String(chart.keys); notePreviewMode.value = "target";
    for (const warning of chart.warnings) appendLog("[CHART] " + warning);
    audioCtx ??= new AudioContext();
    if (kind === "osu") {
      previewMode.value = "target-only"; metronomeSource.value = "osu";
      if (chart.audioPath) {
        try { const bytes = await window.bms2osu.readAudioFile(chart.audioPath);
          if (bytes?.length) state.targetAudioBuffer = await audioCtx.decodeAudioData(bytesToArrayBuffer(bytes));
        } catch (error) { appendLog("[WARN] Song audio unavailable: " + String(error)); }
      }
      state.songLengthMs = Math.max(state.songLengthMs, (state.targetAudioBuffer?.duration ?? 0) * 1000);
    } else {
      previewMode.value = "bms-reference"; metronomeSource.value = "bms";
      for (const [id, file] of Object.entries(chart.files)) {
        try { const bytes = await window.bms2osu.readAudioFile(file);
          if (!bytes?.length) continue;
          const buffer = await audioCtx.decodeAudioData(bytesToArrayBuffer(bytes));
          state.audioBuffers.set(id, analyseBuffer(buffer));
        } catch (error) { appendLog("[WARN] Sample " + id + ": " + String(error)); }
      }
      for (const event of chart.events) state.songLengthMs = Math.max(state.songLengthMs, event.timeMs + (state.audioBuffers.get(event.wavId)?.durationMs ?? 0));
      if (state.audioBuffers.size) state.targetAudioBuffer = audioCtx.createBuffer(2, 1, audioCtx.sampleRate);
    }
    timeline.max = String(Math.max(1, state.songLengthMs / 1000)); timeline.disabled = false;
    timeTotal.textContent = formatTime(state.songLengthMs / 1000); setPosition(0);
    statusEl.textContent = "Original " + (kind === "bms" ? "BMS" : "osu!mania") + " chart loaded — native lanes and timing; no conversion or resnap.";
    state.compatibilityOk = !!state.targetAudioBuffer;
    if (state.compatibilityOk) await warmPreview();
    else { finishPreviewLoading("standalone", true); appendLog("Notes ready. Audio is unavailable; the timeline can still inspect the pattern."); }
    drawNotePreview(); drawWaveform();
  } catch (error) {
    finishPreviewLoading("standalone", false); appendLog("[ERROR] Chart preview: " + String(error));
  } finally { chartSelectionBusy = false; refreshChartSelectors(); btnBms.disabled = false; btnOsu.disabled = false;
    $("btn-clear-bms").removeAttribute("disabled"); $("btn-clear-osu").removeAttribute("disabled");
    checkReady(); btnConvert.disabled = true; }
}
for (const kind of ["bms", "osu"] as const) {
  $("btn-clear-" + kind).onclick = () => {
    if (chartSelectionBusy) return;
    chartFolders[kind] = null;
    const select = $<HTMLSelectElement>("difficulty-" + kind);
    select.replaceChildren(); const empty = document.createElement("option"); empty.textContent = "No folder selected"; select.append(empty); refreshChartSelectors();
    if (kind === "bms") state.bmsPath = ""; else state.osuPath = "";
    if (kind === "bms") fileSummaryBms.textContent = "No BMS selected"; else fileSummaryOsu.textContent = "No osu! map selected";
    $("path-" + kind).textContent = "No " + (kind === "bms" ? "BMS" : "osu! map") + " selected";
    invalidateSelectedPair("Choose Note preview for one chart, or select both files to synchronize."); checkReady();
  };
}

function viewDivision(): number { return clamp(Number($<HTMLSelectElement>("view-division").value) || 4, 1, 16); }
function viewGridLines(startMs: number, endMs: number): { timeMs: number; beat: boolean }[] {
  const lines: { timeMs: number; beat: boolean }[] = [];
  const division = viewDivision(), limit = 512;
  const gap = Math.max(.001, (endMs - startMs) / limit);
  let last = -Infinity;
  const add = (timeMs: number, beat: boolean) => {
    if (Number.isFinite(timeMs) && timeMs >= startMs && timeMs < endMs && timeMs >= last + gap && lines.length < limit) {
      lines.push({ timeMs, beat }); last = timeMs;
    }
  };
  if (state.standaloneKind === "bms" && state.nativeViewGrids[division]) {
    const grid = state.nativeViewGrids[division];
    let lo = 0, hi = grid.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (grid[mid].timeMs < startMs) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < grid.length && grid[i].timeMs < endMs && lines.length < limit;) {
      add(grid[i].timeMs, grid[i].beat);
      const boundary = grid[i].timeMs + gap;
      lo = i + 1; hi = grid.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (grid[mid].timeMs < boundary) lo = mid + 1; else hi = mid; }
      i = lo;
    }
  } else if (state.standaloneKind === "bms") {
    const beats = state.syncedBmsBeatTimes;
    for (let i = 0; i + 1 < beats.length && lines.length < limit; i++) {
      if (beats[i + 1] < startMs) continue; if (beats[i] >= endMs) break;
      for (let n = 0; n < division; n++) add(beats[i] + (beats[i + 1] - beats[i]) * n / division, n === 0);
    }
  } else for (let i = 0; i < state.timingPoints.length && lines.length < limit; i++) {
    const tp = state.timingPoints[i], end = Math.min(endMs, state.timingPoints[i + 1]?.timeMs ?? endMs);
    const from = Math.max(startMs, tp.timeMs, last + gap), step = tp.beatLength / division;
    if (!(step > 0) || !Number.isFinite(step) || end <= from) continue;
    const stride = Math.max(1, Math.ceil(gap / step));
    const first = Math.max(0, Math.ceil((from - tp.timeMs) / step));
    const count = Math.min(limit - lines.length, Math.ceil((end - tp.timeMs - first * step) / (step * stride)));
    for (let n = 0; n < count; n++) { const index = first + n * stride; add(tp.timeMs + index * step, index % division === 0); }
  }
  return lines;
}

function viewScrollStep(timeMs: number, direction = 1): number {
  const grid = state.standaloneKind === "bms" ? state.nativeViewGrids[viewDivision()] : null;
  if (grid?.length) {
    let lo = 0, hi = grid.length;
    const boundary = timeMs + (direction > 0 ? .001 : -.001);
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (grid[mid].timeMs < boundary) lo = mid + 1; else hi = mid; }
    const next = grid[direction > 0 ? lo : lo - 1];
    if (next) return Math.abs(next.timeMs - timeMs) / 1000;
  }
  if (state.standaloneKind === "bms" && state.syncedBmsBeatTimes.length > 1) {
    const i = clamp(nearestIndex(state.syncedBmsBeatTimes, timeMs), 0, state.syncedBmsBeatTimes.length - 2);
    return (state.syncedBmsBeatTimes[i + 1] - state.syncedBmsBeatTimes[i]) / viewDivision() / 1000;
  }
  return (activeTimingPoint(timeMs)?.beatLength ?? 500) / viewDivision() / 1000;
}
$("view-division").onchange = drawNotePreview;
let seekResume = false;
let seekResumeTimer = 0;
let seekTransport = 0;
function beginPreviewSeek(): void {
  window.clearTimeout(seekResumeTimer);
  seekResume = seekResume || previewPlaying;
  if (previewPlaying) stopPreview();
  seekTransport = transportRequest;
}
function finishPreviewSeek(): void {
  if (!seekResume) return;
  if (seekTransport !== transportRequest) { seekResume = false; return; }
  seekResume = false; void startPreview(Number(timeline.value));
}
for (const surface of [waveWrap, noteCanvas] as HTMLElement[]) {
  let drag: { id: number; button: number; x: number; y: number; sec: number } | null = null;
  const positionFor = (ev: PointerEvent) => {
    if (!drag) return;
    const rect = surface.getBoundingClientRect();
    const sec = drag.button === 0 ? (ev.clientX - rect.left) / rect.width * state.songLengthMs / 1000
      : drag.sec + (surface === waveWrap ? (ev.clientX - drag.x) / rect.width * state.songLengthMs / 1000
        : -(ev.clientY - drag.y) / rect.height * (ev.shiftKey ? (11480 / (Number(notePreviewSpeed.value) || 28)) / 1000 : 10));
    setPosition(sec);
  };
  surface.addEventListener("pointerdown", ev => {
    if (timeline.disabled || previewLoadingKey || (ev.button !== 1 && !(surface === waveWrap && ev.button === 0))) return;
    ev.preventDefault(); beginPreviewSeek();
    drag = { id: ev.pointerId, button: ev.button, x: ev.clientX, y: ev.clientY, sec: Number(timeline.value) };
    surface.setPointerCapture(ev.pointerId); positionFor(ev);
  });
  surface.addEventListener("pointermove", ev => { if (drag?.id === ev.pointerId) positionFor(ev); });
  surface.addEventListener("pointerup", ev => {
    if (drag?.id !== ev.pointerId) return; positionFor(ev); drag = null;
    surface.releasePointerCapture(ev.pointerId); finishPreviewSeek();
  });
  surface.addEventListener("pointercancel", () => { drag = null; finishPreviewSeek(); });
  surface.addEventListener("lostpointercapture", () => { if (drag) { drag = null; finishPreviewSeek(); } });
  surface.addEventListener("auxclick", ev => { if (ev.button === 1) ev.preventDefault(); });
  surface.addEventListener("wheel", ev => {
    if (!ev.altKey || timeline.disabled || previewLoadingKey || ev.deltaY === 0) return;
    ev.preventDefault(); beginPreviewSeek();
    const step = ev.shiftKey ? viewScrollStep(Number(timeline.value) * 1000, Math.sign(ev.deltaY)) : 1;
    setPosition(Number(timeline.value) + Math.sign(ev.deltaY) * step);
    seekResumeTimer = window.setTimeout(finishPreviewSeek, 150);
  }, { passive: false });
}
