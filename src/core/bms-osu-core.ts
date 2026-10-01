/**
 * bms-osu-core.ts
 * Pure, environment-agnostic core. NO node:fs, NO DOM, NO JSZip imports here.
 * Web build supplies adapters over the File System Access API + JSZip;
 * desktop build supplies adapters over node:fs.
 */

/* ------------------------------------------------------------------ */
/* 1. I/O abstraction                                                  */
/* ------------------------------------------------------------------ */

export interface FileSource {
  listFiles(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<Uint8Array>;
  /** BMS files are frequently Shift-JIS; decoding is the adapter's job. */
  readText(path: string, encoding?: "utf-8" | "shift_jis"): Promise<string>;
}

export interface OutputSink {
  writeText(relPath: string, data: string): Promise<void>;
  writeBinary(relPath: string, data: Uint8Array): Promise<void>;
  /** .osz sink: generate the zip. Folder sink: no-op. */
  finalize(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* 2. BMS model + parser / timing interfaces                           */
/* ------------------------------------------------------------------ */

/** Exact position inside a measure. Never use floats until the final ms conversion. */
export interface Rational {
  num: number;
  den: number;
}

export interface BmsHeader {
  title?: string;
  artist?: string;
  bpm: number;
  /** base-36 id ("01", "0A", "ZZ") -> filename as written in the BMS */
  wav: Map<string, string>;
  /** #BPMxx table, used by channel 08 */
  bpmTable: Map<string, number>;
  /** #STOPxx table, in 1/192 of a whole note; used by channel 09 */
  stopTable: Map<string, number>;
  lnobj?: string;
}

export interface BmsObject {
  measure: number;
  channel: string; // "01", "03", "08", "09", "11".."19", "21".."29", ...
  position: Rational;
  value: string; // 2-char base-36 token
}

export interface ParsedBms {
  header: BmsHeader;
  /** #xxx02 multipliers (any positive decimal). Missing = 1. */
  measureLengths: Map<number, number>;
  objects: BmsObject[];
}

export interface BmsParser {
  parse(source: FileSource, bmsPath: string): Promise<ParsedBms>;
}

export interface TimingMap {
  /** Absolute milliseconds for a measure/position, honoring 02/03/08/09. */
  toMs(measure: number, position: Rational): number;
}

export interface TimingEngine {
  build(bms: ParsedBms): TimingMap;
}

/** One audible event, before any lane logic. BGM (ch 01) included. */
export interface ScheduledNote {
  timeMs: number; // floating-point absolute BMS time; round only when writing .osu
  wavId: string;
  filename: string;
  channel: string;
  isBgm: boolean;
}

export interface NoteScheduler {
  schedule(bms: ParsedBms, timing: TimingMap): ScheduledNote[];
}

/* ------------------------------------------------------------------ */
/* 3. Instrument grouping (regex)                                      */
/* ------------------------------------------------------------------ */

/**
 * Strips ONE trailing sequence marker from an extension-less name:
 *   "_FX_piano#1" -> "_FX_piano"     "kick_02"  -> "kick"
 *   "pad(3)"      -> "pad"           "snare2"   -> "snare"
 *   "lead-04"     -> "lead"
 * Separators (space _ - .) directly before the number are eaten too.
 * Caveat: "piano_C4" -> "piano_C". Pass a custom pattern if pitch-named
 * files should stay separate.
 */
export const DEFAULT_SEQUENCE_SUFFIX = /[\s_\-.]*[#(\[]?\d+[)\]]?$/;

export const UNNAMED_GROUP = "__unnamed__";

export interface GroupingOptions {
  sequenceSuffix: RegExp;
  caseInsensitive: boolean;
}

export const defaultGrouping: GroupingOptions = {
  sequenceSuffix: DEFAULT_SEQUENCE_SUFFIX,
  caseInsensitive: true,
};

export function instrumentKey(
  filename: string,
  opts: GroupingOptions = defaultGrouping
): string {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const stripped = base.replace(opts.sequenceSuffix, "").replace(/[\s_\-.]+$/, "");
  if (stripped === "") return UNNAMED_GROUP; // purely numeric names like "01.wav"
  return opts.caseInsensitive ? stripped.toLowerCase() : stripped;
}

export interface InstrumentGroup {
  key: string;
  label: string; // first-seen spelling, for reports
  wavIds: string[];
  noteCount: number;
  baseLane: number; // 0-based, 0..17
}

/* ------------------------------------------------------------------ */
/* 4. 18K (9K + 9K) base-lane distributor                              */
/* ------------------------------------------------------------------ */

export const TOTAL_LANES = 18;

export interface LaneOptions {
  totalLanes: number;
  /** Lane ordering of groups: WAV-table order is stable and predictable. */
  order: "first-appearance" | "note-count-desc";
  /**
   * If groups > lanes, "dedicated" is impossible. The smallest groups are
   * folded into the last lane and reported in warnings; collision shifting
   * then spreads them.
   */
  overflow: "merge-smallest-into-last" | "throw";
}

export const defaultLaneOptions: LaneOptions = {
  totalLanes: TOTAL_LANES,
  order: "first-appearance",
  overflow: "merge-smallest-into-last",
};

export interface Distribution {
  groups: InstrumentGroup[];
  laneOfWav: Map<string, number>; // wavId -> base lane
  warnings: string[];
}

export function buildDistribution(
  wav: Map<string, string>,
  notes: ScheduledNote[],
  grouping: GroupingOptions = defaultGrouping,
  opts: LaneOptions = defaultLaneOptions
): Distribution {
  const warnings: string[] = [];
  const byKey = new Map<string, InstrumentGroup>();

  // Group only WAVs that are actually used, in table order.
  const used = new Map<string, number>();
  for (const n of notes) used.set(n.wavId, (used.get(n.wavId) ?? 0) + 1);

  for (const [id, filename] of wav) {
    const count = used.get(id);
    if (!count) continue;
    const key = instrumentKey(filename, grouping);
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: key, wavIds: [], noteCount: 0, baseLane: -1 };
      byKey.set(key, g);
    }
    g.wavIds.push(id);
    g.noteCount += count;
  }

  let groups = [...byKey.values()];
  if (opts.order === "note-count-desc") {
    groups.sort((a, b) => b.noteCount - a.noteCount);
  }

  const max = opts.totalLanes;
  if (groups.length > max) {
    if (opts.overflow === "throw") {
      throw new Error(`${groups.length} instrument groups exceed ${max} lanes`);
    }
    // Keep the (max-1) busiest groups dedicated; fold the rest into one lane.
    const ranked = [...groups].sort((a, b) => b.noteCount - a.noteCount);
    const keep = new Set(ranked.slice(0, max - 1).map((g) => g.key));
    const misc: InstrumentGroup = {
      key: "__misc__",
      label: "__misc__",
      wavIds: [],
      noteCount: 0,
      baseLane: -1,
    };
    const dedicated: InstrumentGroup[] = [];
    for (const g of groups) {
      if (keep.has(g.key)) dedicated.push(g);
      else {
        misc.wavIds.push(...g.wavIds);
        misc.noteCount += g.noteCount;
      }
    }
    warnings.push(
      `${groups.length} groups > ${max} lanes: ${groups.length - dedicated.length} ` +
        `smallest groups merged into lane ${max - 1}.`
    );
    groups = [...dedicated, misc];
  }

  const laneOfWav = new Map<string, number>();
  groups.forEach((g, i) => {
    g.baseLane = i;
    for (const id of g.wavIds) laneOfWav.set(id, i);
  });

  return { groups, laneOfWav, warnings };
}

/* ------------------------------------------------------------------ */
/* 5. Concurrent-note collision shifting                               */
/* ------------------------------------------------------------------ */

export interface PlacedNote extends ScheduledNote {
  lane: number; // final 0-based lane
  baseLane: number;
  shifted: boolean;
}

export interface CollisionResult {
  placed: PlacedNote[];
  /** Notes with no free lane at their millisecond (>18 simultaneous). */
  dropped: ScheduledNote[];
}

/**
 * Two passes per millisecond bucket so a shifted note never steals a lane
 * that another group's note owns at that same instant:
 *   pass 1: every note takes its base lane if free (first come, WAV order)
 *   pass 2: leftovers take the nearest free lane, preferring +1 then -1,
 *           then +2, -2 ... (so "adjacent" first, wider only if needed)
 */
export function resolveCollisions(
  notes: ScheduledNote[],
  laneOfWav: Map<string, number>,
  totalLanes: number = TOTAL_LANES
): CollisionResult {
  const buckets = new Map<number, ScheduledNote[]>();
  for (const n of notes) {
    const list = buckets.get(n.timeMs);
    if (list) list.push(n);
    else buckets.set(n.timeMs, [n]);
  }

  const placed: PlacedNote[] = [];
  const dropped: ScheduledNote[] = [];

  for (const time of [...buckets.keys()].sort((a, b) => a - b)) {
    const bucket = buckets.get(time)!;
    // stable, deterministic order: base lane, then wavId
    bucket.sort(
      (a, b) =>
        (laneOfWav.get(a.wavId) ?? 0) - (laneOfWav.get(b.wavId) ?? 0) ||
        a.wavId.localeCompare(b.wavId)
    );

    const taken = new Array<boolean>(totalLanes).fill(false);
    const leftovers: ScheduledNote[] = [];

    for (const n of bucket) {
      const base = laneOfWav.get(n.wavId) ?? 0;
      if (!taken[base]) {
        taken[base] = true;
        placed.push({ ...n, lane: base, baseLane: base, shifted: false });
      } else {
        leftovers.push(n);
      }
    }

    for (const n of leftovers) {
      const base = laneOfWav.get(n.wavId) ?? 0;
      let lane = -1;
      for (let d = 1; d < totalLanes && lane < 0; d++) {
        if (base + d < totalLanes && !taken[base + d]) lane = base + d;
        else if (base - d >= 0 && !taken[base - d]) lane = base - d;
      }
      if (lane < 0) {
        dropped.push(n);
      } else {
        taken[lane] = true;
        placed.push({ ...n, lane, baseLane: base, shifted: true });
      }
    }
  }

  return { placed, dropped };
}

/* ------------------------------------------------------------------ */
/* 6. .osu [HitObjects] serialization                                  */
/* ------------------------------------------------------------------ */

/** mania column = floor(x * keys / 512), so aim for the lane's center. */
export function laneToX(lane: number, totalLanes: number = TOTAL_LANES): number {
  return Math.floor(((lane + 0.5) * 512) / totalLanes);
}

/**
 * Circle (tap) object: x,y,time,type,hitSound,hitSample
 * hitSample = normalSet:additionSet:index:volume:filename
 * volume 0 = inherit the timing point's volume.
 */
export function toHitObjectLine(
  n: PlacedNote,
  totalLanes: number = TOTAL_LANES,
  volume = 0
): string {
  return `${laneToX(n.lane, totalLanes)},192,${n.timeMs},1,0,0:0:0:${volume}:${n.filename}`;
}

/* ------------------------------------------------------------------ */
/* 7. Pipeline wiring (implementations are injected)                   */
/* ------------------------------------------------------------------ */

export interface ConversionReport {
  hitObjects: string[];
  distribution: Distribution;
  dropped: ScheduledNote[];
  shiftedCount: number;
}

export async function convertBms(
  source: FileSource,
  bmsPath: string,
  deps: { parser: BmsParser; timing: TimingEngine; scheduler: NoteScheduler },
  grouping: GroupingOptions = defaultGrouping,
  laneOpts: LaneOptions = defaultLaneOptions
): Promise<ConversionReport> {
  const bms = await deps.parser.parse(source, bmsPath);
  const timing = deps.timing.build(bms);
  const notes = deps.scheduler.schedule(bms, timing); // includes channel 01

  const distribution = buildDistribution(bms.header.wav, notes, grouping, laneOpts);
  const { placed, dropped } = resolveCollisions(
    notes,
    distribution.laneOfWav,
    laneOpts.totalLanes
  );

  return {
    hitObjects: placed.map((n) => toHitObjectLine(n, laneOpts.totalLanes)),
    distribution,
    dropped,
    shiftedCount: placed.filter((n) => n.shifted).length,
  };
}
