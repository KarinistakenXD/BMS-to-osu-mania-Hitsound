/**
 * bms-parser.ts
 * Environment-agnostic BMS parser. All I/O goes through FileSource.
 *
 * Output guarantees for the TimingEngine:
 *  - every token id is an UPPERCASE 2-char base-36 string (Map keys stay strings)
 *  - every position is an exact, un-reduced Rational { num: index, den: tokens-in-line }
 *  - channel 03 BPM values are decoded as HEX only; channel 08/09 are resolved
 *    through #BPMxx / #STOPxx tables
 *  - `notes` contains only sound-bearing events whose #WAV id exists
 */
import type {
  BmsHeader,
  BmsObject,
  BmsParser,
  FileSource,
  ParsedBms,
  Rational,
} from "./bms-osu-core";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface TimePoint {
  measure: number;
  position: Rational;
}

export type NoteKind = "bgm" | "tap" | "invisible" | "ln";

/** A sound-bearing event. `value` is the base-36 #WAV id (uppercase). */
export interface AudioNote extends BmsObject {
  kind: NoteKind;
  /** Long-note release point. The TimingEngine converts head/end to ms. */
  end?: TimePoint;
}

export interface BpmChange extends TimePoint {
  bpm: number;
  source: "03" | "08";
}

export interface StopEvent extends TimePoint {
  /** #STOPxx value, in 1/192 of a whole note. */
  ticks192: number;
}

export type AudioStatus = "exact" | "case-insensitive" | "extension-swap" | "missing";

export interface AudioResolution {
  wavId: string;
  declared: string;
  /** Path relative to the .bms folder (forward slashes). */
  resolved?: string;
  status: AudioStatus;
}

export interface ResolvedBms extends ParsedBms {
  scrollChanges: (TimePoint & { multiplier: number })[];
  bpmChanges: BpmChange[];
  stops: StopEvent[];
  notes: AudioNote[];
  audio: Map<string, AudioResolution>;
  lnType: number;
  /** Channels we deliberately skip (BGA, landmines, ...) -> token count. */
  ignoredChannels: Map<string, number>;
  warnings: string[];
}

export interface BmsParseOptions {
  /** "auto" = try UTF-8, fall back to Shift-JIS if U+FFFD appears. */
  encoding?: "auto" | "utf-8" | "shift_jis";
  /** Which #IF branch to take for #RANDOM blocks. Default 1. */
  randomRoll?: number;
  /** Probe the folder for the real audio files. Default true. */
  probeAudio?: boolean;
  /** Extension preference when the declared one is absent. */
  audioExtensions?: string[];
}

/* ------------------------------------------------------------------ */
/* Number / rational helpers                                           */
/* ------------------------------------------------------------------ */

const TOKEN_RE = /^[0-9A-Z]{2}$/;
const HEX_TOKEN_RE = /^[0-9A-F]{2}$/;

/** Base-36 value of a 2-char token (BMS ids, #WAV/#BPM/#STOP keys). */
export function b36(token: string): number {
  return parseInt(token, 36);
}

/** Hex value of a 2-char token. Channel 03 ONLY. */
export function hex(token: string): number {
  return parseInt(token, 16);
}

export function compareRational(a: Rational, b: Rational): number {
  return a.num * b.den - b.num * a.den; // dens > 0, so the sign is exact
}

export function comparePoint(a: TimePoint, b: TimePoint): number {
  return a.measure - b.measure || compareRational(a.position, b.position);
}

/* ------------------------------------------------------------------ */
/* Warning collector (first few per code, then a count)                */
/* ------------------------------------------------------------------ */

class Diagnostics {
  private counts = new Map<string, number>();
  private samples = new Map<string, string[]>();

  warn(code: string, message: string): void {
    const n = (this.counts.get(code) ?? 0) + 1;
    this.counts.set(code, n);
    if (n <= 3) {
      const list = this.samples.get(code);
      if (list) list.push(message);
      else this.samples.set(code, [message]);
    }
  }

  toArray(): string[] {
    const out: string[] = [];
    for (const [code, list] of this.samples) {
      for (const m of list) out.push(`[${code}] ${m}`);
      const total = this.counts.get(code) ?? 0;
      if (total > list.length) out.push(`[${code}] ...and ${total - list.length} more`);
    }
    return out;
  }
}

/* ------------------------------------------------------------------ */
/* Line grammar                                                        */
/* ------------------------------------------------------------------ */

const DATA_RE = /^#(\d{3})([0-9A-Za-z]{2})\s*:\s*(.*)$/;
const WAV_RE = /^#WAV([0-9A-Za-z]{2})\s+(.+)$/i;
const BPM_TABLE_RE = /^#(?:EX)?BPM([0-9A-Za-z]{2})\s+(\S+)/i;
const BPM_BASE_RE = /^#BPM\s+(\S+)/i;
const STOP_RE = /^#STOP([0-9A-Za-z]{2})\s+(\S+)/i;
const LNOBJ_RE = /^#LNOBJ\s+([0-9A-Za-z]{2})/i;
const LNTYPE_RE = /^#LNTYPE\s+(\d+)/i;
const META_RE = /^#(TITLE|ARTIST)\s+(.*)$/i;
const RANDOM_RE = /^#(?:SET)?RANDOM\s+\d+/i;
const ENDRANDOM_RE = /^#ENDRANDOM\b/i;
const IF_RE = /^#IF\s+(\d+)/i;
const ENDIF_RE = /^#END\s*IF\b/i;

type ChannelClass =
  | "bgm"
  | "tap"
  | "invisible"
  | "ln"
  | "length"
  | "bpm-hex"
  | "bpm-ext"
  | "stop"
  | "other";

export function classifyChannel(ch: string): ChannelClass {
  switch (ch) {
    case "01":
      return "bgm";
    case "02":
      return "length";
    case "03":
      return "bpm-hex";
    case "08":
      return "bpm-ext";
    case "09":
      return "stop";
  }
  if (/^[12][1-9]$/.test(ch)) return "tap"; // visible P1 / P2
  if (/^[34][1-9]$/.test(ch)) return "invisible"; // invisible P1 / P2 (still play sound)
  if (/^[56][1-9]$/.test(ch)) return "ln"; // long-note channels P1 / P2
  return "other";
}

/* ------------------------------------------------------------------ */
/* Pure text -> ResolvedBms (no I/O, unit-testable)                    */
/* ------------------------------------------------------------------ */

export function parseBmsText(text: string, options: BmsParseOptions = {}): ResolvedBms {
  const diag = new Diagnostics();
  const header: BmsHeader = {
    bpm: 120,
    wav: new Map(),
    bpmTable: new Map(),
    stopTable: new Map(),
  };
  const measureLengths = new Map<number, number>();
  const raw: BmsObject[] = [];
  const scrollTable = new Map<string, number>();
  const ignored = new Map<string, number>();
  const roll = options.randomRoll ?? 1;
  const ifStack: boolean[] = [];
  let sawBpm = false;
  let sawRandom = false;
  let lnType = 1;

  const lines = text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim().replace(/^#EXT\s+(?=#)/i, "");
    if (line[0] !== "#") continue;

    /* ---- #RANDOM / #IF flow control ---- */
    if (ENDIF_RE.test(line)) {
      ifStack.pop();
      continue;
    }
    let m: RegExpExecArray | null = IF_RE.exec(line);
    if (m) {
      ifStack.push(parseInt(m[1], 10) === roll);
      continue;
    }
    if (RANDOM_RE.test(line)) {
      if (!sawRandom) {
        sawRandom = true;
        diag.warn("random", `#RANDOM blocks present; always taking #IF ${roll}`);
      }
      continue;
    }
    if (ENDRANDOM_RE.test(line)) continue;
    if (!ifStack.every(Boolean)) continue;

    /* ---- data lines: #MMMCC:.... ---- */
    m = DATA_RE.exec(line);
    if (m) {
      const measure = parseInt(m[1], 10);
      const channel = m[2].toUpperCase();
      const data = m[3].replace(/\s+/g, "");

      if (channel === "02") {
        const v = Number(data);
        if (Number.isFinite(v) && v > 0) measureLengths.set(measure, v);
        else diag.warn("bad-length", `#${m[1]}02 has invalid value "${data}"`);
        continue;
      }

      let body = data;
      if (body.length % 2 === 1) {
        diag.warn("odd-data", `#${m[1]}${channel} has odd length; last char dropped`);
        body = body.slice(0, -1);
      }
      const total = body.length / 2;
      for (let i = 0; i < total; i++) {
        const tok = body.slice(2 * i, 2 * i + 2).toUpperCase();
        if (tok === "00") continue;
        if (!TOKEN_RE.test(tok)) {
          diag.warn("bad-token", `#${m[1]}${channel} has invalid token "${tok}"`);
          continue;
        }
        raw.push({ measure, channel, position: { num: i, den: total }, value: tok });
      }
      continue;
    }

    /* ---- header commands ---- */
    if (/^#SPEED[0-9A-Za-z]{2}\s/i.test(line)) {
      diag.warn("scroll", "BMS SPEED/SP spacing extensions are not supported by this preview.");
      continue;
    }
    m = /^#SCROLL([0-9A-Za-z]{2})\s+(\S+)/i.exec(line);
    if (m) {
      const value = Number(m[2]);
      if (Number.isFinite(value) && value > 0) scrollTable.set(m[1].toUpperCase(), value);
      else diag.warn("scroll", "Nonpositive/reverse BMS scrolling is not supported by this preview.");
      continue;
    }
    m = WAV_RE.exec(line);
    if (m) {
      header.wav.set(m[1].toUpperCase(), m[2].trim().replace(/\\/g, "/"));
      continue;
    }
    m = BPM_TABLE_RE.exec(line);
    if (m) {
      const v = Number(m[2]);
      if (Number.isFinite(v) && v > 0) header.bpmTable.set(m[1].toUpperCase(), v);
      else diag.warn("bad-bpm", `#BPM${m[1]} has invalid value "${m[2]}"`);
      continue;
    }
    m = BPM_BASE_RE.exec(line);
    if (m) {
      const v = Number(m[1]);
      if (Number.isFinite(v) && v > 0) {
        header.bpm = v;
        sawBpm = true;
      } else diag.warn("bad-bpm", `#BPM has invalid value "${m[1]}"`);
      continue;
    }
    m = STOP_RE.exec(line);
    if (m) {
      const v = Number(m[2]);
      if (Number.isFinite(v) && v >= 0) header.stopTable.set(m[1].toUpperCase(), v);
      else diag.warn("bad-stop", `#STOP${m[1]} has invalid value "${m[2]}"`);
      continue;
    }
    m = LNOBJ_RE.exec(line);
    if (m) {
      header.lnobj = m[1].toUpperCase();
      continue;
    }
    m = LNTYPE_RE.exec(line);
    if (m) {
      lnType = parseInt(m[1], 10);
      continue;
    }
    m = META_RE.exec(line);
    if (m) {
      if (m[1].toUpperCase() === "TITLE") header.title = m[2].trim();
      else header.artist = m[2].trim();
      continue;
    }
  }

  if (!sawBpm) diag.warn("bpm-missing", "no #BPM header; defaulting to 120");
  if (lnType !== 1) diag.warn("lntype", `#LNTYPE ${lnType} unsupported; treating as type 1`);

  raw.sort((a, b) => comparePoint(a, b) || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));

  /* ---- resolve timing channels ---- */
  const bpmChanges: BpmChange[] = [];
  const scrollChanges: (TimePoint & { multiplier: number })[] = [];
  const stops: StopEvent[] = [];
  const notes: AudioNote[] = [];
  const tapByChannel = new Map<string, BmsObject[]>();
  const lnByChannel = new Map<string, BmsObject[]>();

  for (const o of raw) {
    if (o.channel === "SC") {
      const multiplier = scrollTable.get(o.value);
      if (multiplier !== undefined) scrollChanges.push({ measure: o.measure, position: o.position, multiplier });
      else diag.warn("scroll", `SC references unsupported or missing #SCROLL${o.value}`);
      continue;
    }
    if (o.channel === "SP") diag.warn("scroll", "BMS SPEED/SP spacing extensions are not supported by this preview.");
    switch (classifyChannel(o.channel)) {
      case "bpm-hex": {
        // Channel 03 is HEX, never base-36.
        if (!HEX_TOKEN_RE.test(o.value)) {
          diag.warn("bpm-hex", `ch03 token "${o.value}" is not hex`);
          break;
        }
        const bpm = hex(o.value);
        if (bpm <= 0) diag.warn("bpm-hex", `ch03 BPM ${o.value} <= 0 ignored`);
        else bpmChanges.push({ measure: o.measure, position: o.position, bpm, source: "03" });
        break;
      }
      case "bpm-ext": {
        const bpm = header.bpmTable.get(o.value);
        if (bpm === undefined) diag.warn("bpm-ext", `ch08 references undefined #BPM${o.value}`);
        else bpmChanges.push({ measure: o.measure, position: o.position, bpm, source: "08" });
        break;
      }
      case "stop": {
        const ticks = header.stopTable.get(o.value);
        if (ticks === undefined) diag.warn("stop", `ch09 references undefined #STOP${o.value}`);
        else stops.push({ measure: o.measure, position: o.position, ticks192: ticks });
        break;
      }
      case "bgm":
        notes.push({ ...o, kind: "bgm" });
        break;
      case "invisible":
        notes.push({ ...o, kind: "invisible" });
        break;
      case "tap": {
        const list = tapByChannel.get(o.channel);
        if (list) list.push(o);
        else tapByChannel.set(o.channel, [o]);
        break;
      }
      case "ln": {
        const list = lnByChannel.get(o.channel);
        if (list) list.push(o);
        else lnByChannel.set(o.channel, [o]);
        break;
      }
      default:
        ignored.set(o.channel, (ignored.get(o.channel) ?? 0) + 1);
    }
  }

  /* ---- #LNOBJ interception on 11-19 / 21-29 ---- */
  for (const [ch, list] of tapByChannel) {
    let prev: AudioNote | null = null;
    for (const o of list) {
      if (header.lnobj !== undefined && o.value === header.lnobj) {
        if (prev && comparePoint(prev, o) < 0) {
          prev.kind = "ln";
          prev.end = { measure: o.measure, position: o.position };
          prev = null; // a head can only be closed once
        } else {
          diag.warn("lnobj-orphan", `#LNOBJ end on ch${ch} m${o.measure} has no preceding note`);
        }
        continue; // the release token itself is not a sound
      }
      const n: AudioNote = { ...o, kind: "tap" };
      notes.push(n);
      prev = n;
    }
  }

  /* ---- LN channels 51-59 / 61-69: consecutive start/end pairs ---- */
  for (const [ch, list] of lnByChannel) {
    let i = 0;
    while (i < list.length) {
      const head = list[i];
      const end = list[i + 1];
      if (end && comparePoint(head, end) < 0) {
        notes.push({
          ...head,
          kind: "ln",
          end: { measure: end.measure, position: end.position },
        });
        i += 2;
      } else {
        diag.warn("ln-unpaired", `LN head on ch${ch} m${head.measure} has no end; kept as tap`);
        notes.push({ ...head, kind: "tap" });
        i += 1;
      }
    }
  }

  /* ---- sanitize: drop notes whose #WAV id is undefined ---- */
  const undefinedIds = new Set<string>();
  const valid = notes.filter((n) => {
    if (header.wav.has(n.value)) return true;
    undefinedIds.add(n.value);
    return false;
  });
  if (undefinedIds.size > 0) {
    diag.warn(
      "undefined-wav",
      `${notes.length - valid.length} notes use undefined #WAV ids (${[...undefinedIds].join(", ")}); dropped`
    );
  }
  valid.sort((a, b) => comparePoint(a, b) || (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0));

  return {
    header,
    measureLengths,
    objects: raw,
    bpmChanges,
    scrollChanges,
    stops,
    notes: valid,
    audio: new Map(),
    lnType,
    ignoredChannels: ignored,
    warnings: diag.toArray(),
  };
}

/* ------------------------------------------------------------------ */
/* Audio extension probing (uses only FileSource.listFiles / exists)   */
/* ------------------------------------------------------------------ */

const DEFAULT_AUDIO_EXTS = ["ogg", "wav", "flac", "mp3"];

function joinPath(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}/${b}`;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

interface DirIndex {
  listed: boolean;
  byFull: Map<string, string>; // lowercased filename -> real filename
  byStem: Map<string, string[]>; // lowercased stem -> real filenames
}

async function indexDir(
  source: FileSource,
  dir: string,
  cache: Map<string, DirIndex>
): Promise<DirIndex> {
  const hit = cache.get(dir);
  if (hit) return hit;
  const idx: DirIndex = { listed: false, byFull: new Map(), byStem: new Map() };
  try {
    const names = await source.listFiles(dir);
    for (const entry of names) {
      const name = entry.replace(/\\/g, "/").split("/").pop() as string;
      if (!name) continue;
      idx.byFull.set(name.toLowerCase(), name);
      const dot = name.lastIndexOf(".");
      const stem = (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
      const list = idx.byStem.get(stem);
      if (list) list.push(name);
      else idx.byStem.set(stem, [name]);
    }
    idx.listed = names.length > 0;
  } catch {
    /* listing unsupported: fall back to exists() probing */
  }
  cache.set(dir, idx);
  return idx;
}

async function resolveOne(
  source: FileSource,
  bmsDir: string,
  declared: string,
  exts: string[],
  cache: Map<string, DirIndex>
): Promise<{ resolved?: string; status: AudioStatus }> {
  const rel = declared.replace(/\\/g, "/");
  const slash = rel.lastIndexOf("/");
  const sub = slash >= 0 ? rel.slice(0, slash) : "";
  const file = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = file.lastIndexOf(".");
  const stem = dot > 0 ? file.slice(0, dot) : file;
  const withSub = (name: string) => joinPath(sub, name);
  const idx = await indexDir(source, joinPath(bmsDir, sub), cache);

  if (idx.listed) {
    const same = idx.byFull.get(file.toLowerCase());
    if (same) {
      return { resolved: withSub(same), status: same === file ? "exact" : "case-insensitive" };
    }
    const siblings = idx.byStem.get(stem.toLowerCase()) ?? [];
    for (const ext of exts) {
      const found = siblings.find((n) => n.toLowerCase().endsWith("." + ext));
      if (found) return { resolved: withSub(found), status: "extension-swap" };
    }
    return { status: "missing" };
  }

  if (await source.exists(joinPath(bmsDir, rel))) return { resolved: rel, status: "exact" };
  for (const ext of exts) {
    const alt = withSub(`${stem}.${ext}`);
    if (await source.exists(joinPath(bmsDir, alt))) {
      return { resolved: alt, status: "extension-swap" };
    }
  }
  return { status: "missing" };
}

/**
 * Fills bms.audio and rewrites header.wav to the files that actually exist,
 * so downstream grouping and hitSample names use real filenames.
 */
export async function attachAudio(
  source: FileSource,
  bmsDir: string,
  bms: ResolvedBms,
  options: BmsParseOptions = {}
): Promise<void> {
  const exts = options.audioExtensions ?? DEFAULT_AUDIO_EXTS;
  const cache = new Map<string, DirIndex>();
  const used = new Set(bms.notes.map((n) => n.value));
  const missing: string[] = [];
  let swapped = 0;

  for (const [id, declared] of [...bms.header.wav]) {
    const r = await resolveOne(source, bmsDir, declared, exts, cache);
    bms.audio.set(id, { wavId: id, declared, resolved: r.resolved, status: r.status });
    if (r.resolved) {
      bms.header.wav.set(id, r.resolved);
      if (r.status === "extension-swap" && used.has(id)) swapped++;
    } else if (used.has(id)) {
      missing.push(declared);
    }
  }

  if (swapped > 0) bms.warnings.push(`[audio-ext] ${swapped} used samples resolved via extension swap`);
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(", ");
    bms.warnings.push(
      `[audio-missing] ${missing.length} used samples not found (${shown}${missing.length > 5 ? ", ..." : ""})`
    );
  }
}

/* ------------------------------------------------------------------ */
/* File-based parser (implements the core BmsParser interface)         */
/* ------------------------------------------------------------------ */

async function readBmsText(
  source: FileSource,
  path: string,
  encoding: "auto" | "utf-8" | "shift_jis"
): Promise<string> {
  if (encoding !== "auto") return source.readText(path, encoding);
  const utf8 = await source.readText(path, "utf-8");
  if (!utf8.includes("\uFFFD")) return utf8;
  return source.readText(path, "shift_jis");
}

export class BmsFileParser implements BmsParser {
  private readonly options: BmsParseOptions;

  constructor(options: BmsParseOptions = {}) {
    this.options = options;
  }

  async parse(source: FileSource, bmsPath: string): Promise<ResolvedBms> {
    const path = bmsPath.replace(/\\/g, "/");
    const text = await readBmsText(source, path, this.options.encoding ?? "auto");
    const bms = parseBmsText(text, this.options);
    if (this.options.probeAudio !== false) {
      await attachAudio(source, dirOf(path), bms, this.options);
    }
    return bms;
  }
}
