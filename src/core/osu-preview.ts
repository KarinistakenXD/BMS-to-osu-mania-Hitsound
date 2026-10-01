import * as fs from "node:fs/promises";
import * as path from "node:path";

export async function readOsuPreview(osuPath: string, bmsPath: string) {
  const osuText = await fs.readFile(osuPath, "utf-8");
  const rawAudio = osuText.match(/^\s*AudioFilename\s*:\s*(.+?)\s*$/mi)?.[1]?.trim().replace(/^"|"$/g, "");
  const osuAudioPath = rawAudio ? path.resolve(path.dirname(osuPath), rawAudio) : null;
  const osuMeta = {
    title: (osuText.match(/^\s*Title\s*:\s*(.*?)\s*$/mi)?.[1] ?? "").trim(),
    artist: (osuText.match(/^\s*Artist\s*:\s*(.*?)\s*$/mi)?.[1] ?? "").trim(),
    creator: (osuText.match(/^\s*Creator\s*:\s*(.*?)\s*$/mi)?.[1] ?? "").trim(),
    version: (osuText.match(/^\s*Version\s*:\s*(.*?)\s*$/mi)?.[1] ?? "").trim(),
  };
  // Target osu! difficulty metadata + hitobjects for visual note preview.
  // This does not alter conversion; it only lets the renderer compare the
  // generated hitsound diff against the selected target difficulty.
  const mode = Number(osuText.match(/^\s*Mode\s*:\s*(\d+)\s*$/mi)?.[1] ?? 0);
  const targetKeys = Math.max(1, Math.round(Number(osuText.match(/^\s*CircleSize\s*:\s*([\d.]+)\s*$/mi)?.[1] ?? 4)));
  const hitObjectSection = osuText.match(/\[HitObjects\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "";
  const targetNotes = mode === 3
    ? hitObjectSection
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("//"))
        .map(line => {
          const parts = line.split(",");
          if (parts.length < 5) return null;
          const x = Number(parts[0]);
          const timeMs = Number(parts[2]);
          const type = Number(parts[3]);
          if (!Number.isFinite(x) || !Number.isFinite(timeMs) || !Number.isFinite(type)) return null;
          const isCircle = (type & 1) !== 0;
          const isHold = (type & 128) !== 0;
          if (!isCircle && !isHold) return null;
          const lane = Math.max(0, Math.min(targetKeys - 1, Math.floor((x * targetKeys) / 512)));
          let endTimeMs = timeMs;
          if (isHold && parts[5]) {
            const holdEnd = Number(parts[5].split(":")[0]);
            if (Number.isFinite(holdEnd) && holdEnd >= timeMs) endTimeMs = holdEnd;
          }
          return { timeMs, endTimeMs, lane };
        })
        .filter((n): n is { timeMs: number; endTimeMs: number; lane: number } => n !== null)
        .sort((a, b) => a.timeMs - b.timeMs)
    : [];

  // Target osu! red timing points. These are authoritative for target-grid
  // resnapping and the default metronome.
  const timingPoints = osuText
    .match(/\[TimingPoints\]([\s\S]*?)(?:\n\[|$)/)?.[1]
    ?.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("//"))
    .map(line => line.split(","))
    .filter(parts => parts.length >= 2 && (parts[6] ?? "1") === "1")
    .map(parts => ({
      timeMs: Number(parts[0]),
      beatLength: Number(parts[1]),
      meter: Math.max(1, Number(parts[2]) || 4),
    }))
    .filter(tp => Number.isFinite(tp.timeMs) && Number.isFinite(tp.beatLength) && tp.beatLength > 0)
    .sort((a, b) => a.timeMs - b.timeMs) ?? [];


  const identity = async (file: string | null) => {
    if (!file) return null;
    try {
      const stat = await fs.stat(file);
      return [await fs.realpath(file), stat.size, stat.mtimeMs, stat.ctimeMs];
    } catch { return null; }
  };
  const [audioIdentity, bmsIdentity] = await Promise.all([identity(osuAudioPath), identity(bmsPath)]);
  const timingRows = (osuText.match(/\[TimingPoints\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "")
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith("//"))
    .map(line => line.split(",").map(part => part.trim()));
  const normalize = (value: string) => value.normalize("NFKC").trim().toLowerCase();
  const reuseKey = audioIdentity && bmsIdentity && osuMeta.title && osuMeta.artist && timingRows.length
    ? JSON.stringify([audioIdentity, bmsIdentity, normalize(osuMeta.title), normalize(osuMeta.artist), timingRows, mode])
    : "";
  return { osuAudioPath, timingPoints, metadata: osuMeta, osuPreview: { mode, keys: targetKeys, notes: targetNotes }, reuseKey };
}
