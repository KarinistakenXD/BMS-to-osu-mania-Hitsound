import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseBmsText } from "./bms-parser";
import { NodeFileSource } from "./node-io";

export interface ChartChoice { path: string; label: string; keys: number; rank: number[]; keyboardKeys?: number; scratches?: number; }
// Inspect only charts directly inside the selected song folder; never decode audio.
export async function readChartFolder(folder: string, kind: "bms" | "osu") {
  const charts: ChartChoice[] = [], warnings: string[] = [];
  const entries = await fs.readdir(folder, { withFileTypes: true });
  for (const entry of entries.filter(e => e.isFile()).sort((a,b) => a.name.localeCompare(b.name))) {
    const ext = path.extname(entry.name).toLowerCase();
    if (!(kind === "osu" ? ext === ".osu" : [".bms", ".bme", ".bmx", ".bml", ".pms"].includes(ext))) continue;
    const file = path.join(folder, entry.name);
    try {
      const source = new NodeFileSource();
      let text = await source.readText(file, "utf-8");
      if (kind === "bms" && text.includes("\uFFFD")) text = await source.readText(file, "shift_jis");
      if (kind === "osu") {
        const mode = Number(text.match(/^\s*Mode\s*:\s*(\d+)\s*$/mi)?.[1] ?? 0);
        if (mode !== 3) { warnings.push(`${entry.name}: rejected — only osu!mania (Mode 3) is supported.`); continue; }
        const keys = Number(text.match(/^\s*CircleSize\s*:\s*([\d.]+)\s*$/mi)?.[1]);
        if (!Number.isInteger(keys) || keys < 1 || keys > 18) throw new Error("invalid mania key count");
        const name = text.match(/^\s*Version\s*:\s*(.*?)\s*$/mi)?.[1]?.trim() || entry.name;
        const od = text.match(/^\s*OverallDifficulty\s*:\s*([\d.]+)\s*$/mi)?.[1];
        const hp = text.match(/^\s*HPDrainRate\s*:\s*([\d.]+)\s*$/mi)?.[1];
        const heads = (text.match(/\[HitObjects\]([\s\S]*?)(?:\n\[|$)/)?.[1] ?? "").split(/\r?\n/)
          .map(row => row.split(",")).filter(p => (Number(p[3]) & 129) !== 0)
          .map(p => Number(p[2])).filter(Number.isFinite).sort((a,b) => a-b);
        let peak = 0, left = 0;
        for (let right = 0; right < heads.length; right++) {
          while (heads[right] - heads[left] > 10000) left++;
          peak = Math.max(peak, right - left + 1);
        }
        // Relative default within a folder, not an osu! star-rating calculation.
        charts.push({ path: file, keys, label: `[${keys}K] ${name} | OD/HP: ${od ?? "—"}/${hp ?? "—"}`,
          rank: [peak, heads.length, Number(od) || 0, Number(hp) || 0] });
      } else {
        const chart = parseBmsText(text);
        const visible = chart.notes.filter(n => n.kind === "tap" || n.kind === "ln");
        const side = visible.some(n => /^[1256][89]$/.test(n.channel)) ? 8 : 6;
        const dp = visible.some(n => /^[26]/.test(n.channel));
        const keys = ext === ".pms" ? 9 : side * (dp ? 2 : 1);
        const level = text.match(/^#PLAYLEVEL\s+(\S+)/mi)?.[1];
        const subtitle = text.match(/^#SUBTITLE\s+(.+)$/mi)?.[1]?.trim().replace(/^\[|\]$/g, "");
        const brackets = [...(chart.header.title || "").matchAll(/\[([^\]]+)\]/g)];
        const difficulty = subtitle || brackets.at(-1)?.[1] || path.basename(entry.name, ext);
        const playableKeys = ext === ".pms" ? keys : keys - (dp ? 2 : 1);
        charts.push({ path: file, keys, keyboardKeys: playableKeys, scratches: ext === ".pms" ? 0 : dp ? 2 : 1,
          label: `[${playableKeys}K${ext === ".pms" ? "" : dp ? ", 2 Scratch" : ", Scratch"}] [${difficulty}] LV. ${level ?? "—"}`,
          rank: [Number(level) || 0, visible.length] });
      }
    } catch (error) { warnings.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const labelCounts = new Map<string, number>();
  for (const chart of charts) labelCounts.set(chart.label, (labelCounts.get(chart.label) ?? 0) + 1);
  for (const chart of charts) if ((labelCounts.get(chart.label) ?? 0) > 1)
    chart.label += ` · ${path.basename(chart.path)}`;
  const hardestFirst = (a: ChartChoice, b: ChartChoice) => {
    for (let i = 0; i < Math.max(a.rank.length,b.rank.length); i++) {
      const difference = (b.rank[i] ?? 0) - (a.rank[i] ?? 0);
      if (difference) return difference;
    }
    return a.path.localeCompare(b.path);
  };
  const defaultPath = [...charts].sort(hardestFirst)[0]?.path ?? "";
  charts.sort(kind === "bms" ? (a,b) => (a.keyboardKeys! - b.keyboardKeys!) || (a.scratches! - b.scratches!) ||
    (a.rank[0] - b.rank[0]) || a.path.localeCompare(b.path) : hardestFirst);
  return { folder, charts, warnings, defaultPath };
}
