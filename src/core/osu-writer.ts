/**
 * osu-writer.ts
 * Turns a list of already-formatted [HitObjects] lines into either an
 * edit of an existing .osu file or a minimal standalone one.
 */

const SECTION_RE = /\r?\n\[[A-Za-z]+\]/;

/**
 * Replaces the body of an existing [HitObjects] section with the generated
 * lines (or appends the section if the file doesn't have one yet).
 * The section header itself, and every other section, are left untouched.
 */
export function injectHitObjects(osuText: string, hitObjects: string[]): string {
  const marker = "[HitObjects]";
  const idx = osuText.indexOf(marker);
  const body = hitObjects.join("\n");

  if (idx === -1) {
    return `${osuText.replace(/\s*$/, "")}\n\n${marker}\n${body}\n`;
  }

  const afterHeader = idx + marker.length;
  const rest = osuText.slice(afterHeader);
  const nextSection = rest.match(SECTION_RE);
  const sectionEnd = nextSection ? afterHeader + (nextSection.index as number) : osuText.length;

  const before = osuText.slice(0, afterHeader);
  const after = osuText.slice(sectionEnd);
  return `${before}\n${body}\n${after}`;
}

export interface MinimalOsuOptions {
  title: string;
  artist: string;
  creator: string;
  version: string;
  keys: number;
  hitObjects: string[];
  audioFilename?: string;
  /** osu! beatmap id fields; 0/-1 mean "unsubmitted". */
  beatmapId?: number;
  beatmapSetId?: number;
}

/**
 * A self-contained mania .osu. Good enough to open and edit in the editor;
 * NOT a substitute for exporting from the actual map this BMS is meant to
 * pair with (background, preview point, combo colours, etc. are omitted).
 */
export function buildMinimalOsu(opts: MinimalOsuOptions): string {
  const {
    title,
    artist,
    creator,
    version,
    keys,
    hitObjects,
    audioFilename = "audio.mp3",
    beatmapId = 0,
    beatmapSetId = -1,
  } = opts;

  return [
    "osu file format v14",
    "",
    "[General]",
    `AudioFilename: ${audioFilename}`,
    "AudioLeadIn: 0",
    "PreviewTime: -1",
    "Countdown: 0",
    "SampleSet: Soft",
    "StackLeniency: 0.7",
    "Mode: 3",
    "LetterboxInBreaks: 0",
    "SpecialStyle: 0",
    "WidescreenStoryboard: 0",
    "",
    "[Metadata]",
    `Title:${title}`,
    `TitleUnicode:${title}`,
    `Artist:${artist}`,
    `ArtistUnicode:${artist}`,
    `Creator:${creator}`,
    `Version:${version}`,
    "Source:",
    "Tags:bms converted keysounds",
    `BeatmapID:${beatmapId}`,
    `BeatmapSetID:${beatmapSetId}`,
    "",
    "[Difficulty]",
    `HPDrainRate:8`,
    `CircleSize:${keys}`,
    `OverallDifficulty:8`,
    `ApproachRate:5`,
    `SliderMultiplier:1.4`,
    `SliderTickRate:1`,
    "",
    "[Events]",
    "//Background and Video events",
    "//Break Periods",
    "//Storyboard Layer 0 (Background)",
    "//Storyboard Layer 1 (Fail)",
    "//Storyboard Layer 2 (Pass)",
    "//Storyboard Layer 3 (Foreground)",
    "//Storyboard Layer 4 (Overlay)",
    "//Storyboard Sound Samples",
    "",
    "[TimingPoints]",
    // One uninherited point so the editor has a valid timeline; hit object
    // times are absolute ms and don't depend on this BPM.
    "0,500,4,1,0,100,1,0",
    "",
    "[HitObjects]",
    ...hitObjects,
    "",
  ].join("\n");
}
