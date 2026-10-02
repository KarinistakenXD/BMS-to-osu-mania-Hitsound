import { isLanguage, translateText, type Language } from "../src/core/language";
/**
 * electron/main.ts
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain } from "electron";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { setupPreferences } from "../src/core/windows-setup";

import { BmsFileParser } from "../src/core/bms-parser";
import { BmsTimingEngine } from "../src/core/bms-timing";
import { readStandaloneChart } from "../src/core/standalone-preview";
import { readOsuPreview } from "../src/core/osu-preview";
import { NodeFileSource } from "../src/core/node-io";
import { readChartFolder } from "../src/core/chart-folder";

let win: BrowserWindow | null = null;

function appIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "build", "icon.ico");
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 860,
    minWidth: 900,
    minHeight: 700,
    icon: appIconPath(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "../../dist/index.html"));
  win.webContents.once("did-finish-load", () => {
    setTimeout(() => {
      void promptForFfmpeg("audio conversion and pitch-preserving slow preview");
    }, 600);
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function log(line: string): void {
  win?.webContents.send("log", line);
}

/* ------------------------------------------------------------------ */
/* Folder Memory                                                       */
/* ------------------------------------------------------------------ */
const getConfigPath = () => path.join(app.getPath("userData"), "bms-prefs.json");

async function getPref(key: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(getConfigPath(), "utf-8");
    return JSON.parse(text)[key];
  } catch { return undefined; }
}

async function setPref(key: string, val: string): Promise<void> {
  try {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(await fs.readFile(getConfigPath(), "utf-8")); } catch {}
    data[key] = val;
    await fs.writeFile(getConfigPath(), JSON.stringify(data));
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */
let uiLanguage: Language = "en";
const tr = (text: string) => translateText(text, uiLanguage);
ipcMain.handle("ui:startupPreferences", () => setupPreferences());
ipcMain.handle("ui:language", (_e, language: unknown) => { if (isLanguage(language)) uiLanguage = language; });

ipcMain.handle("dialog:chartFolder", async (_e, kind) => {
  if (kind !== "bms" && kind !== "osu") throw new Error("Unsupported chart kind");
  const pref = kind === "bms" ? "sourceDir" : "destDir";
  const defaultFolder = await getPref(pref) ?? (kind === "osu" ? (await setupPreferences()).songsFolder : undefined);
  const result = await dialog.showOpenDialog(win!, { title: tr(`Select ${kind === "bms" ? "BMS" : "osu!mania"} song folder`), defaultPath: defaultFolder, properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  try {
    const folder = await readChartFolder(result.filePaths[0], kind);
    for (const warning of folder.warnings) log("[CHART] " + warning);
    if (folder.warnings.length || !folder.charts.length) await dialog.showMessageBox(win!, {
      type: "warning", title: tr("Chart folder"), message: tr(folder.charts.length ? "Some files were rejected; supported difficulties are available." : "No supported charts found in this folder."),
      detail: folder.warnings.slice(0, 12).join("\n") || "Choose the song folder containing chart files.",
    });
    if (!folder.charts.length) return null;
    await setPref(pref, folder.folder); return folder;
  } catch (error) {
    await dialog.showMessageBox(win!, { type: "error", message: tr("Could not read chart folder"), detail: String(error) }); return null;
  }
});
ipcMain.handle("dialog:selectBms", async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: tr("Select a BMS file"),
    defaultPath: await getPref("sourceDir"),
    properties: ["openFile"],
    filters: [{ name: "BMS charts", extensions: ["bms", "bme", "bml", "pms", "bmx"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  await setPref("sourceDir", path.dirname(res.filePaths[0]));
  return res.filePaths[0];
});

ipcMain.handle("dialog:selectOsu", async () => {
  const res = await dialog.showOpenDialog(win!, {
    title: tr("Select Target .osu File"),
    defaultPath: await getPref("destDir") ?? (await setupPreferences()).songsFolder,
    properties: ["openFile"],
    filters: [{ name: "osu! beatmap", extensions: ["osu"] }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  await setPref("destDir", path.dirname(res.filePaths[0]));
  return res.filePaths[0];
});

ipcMain.handle("dialog:pairCheck", async (_e, options: {
  kind: "warning" | "error";
  title: string;
  message: string;
  detail: string;
  allowContinue: boolean;
}) => {
  if (!win) return false;
  const buttons = options.allowContinue ? ["Continue anyway", "Cancel"] : ["OK"];
  const result = await dialog.showMessageBox(win, {
    type: options.kind,
    title: tr(options.title),
    message: tr(options.message),
    detail: options.detail,
    buttons: buttons.map(tr),
    defaultId: 0,
    cancelId: options.allowContinue ? 1 : 0,
    noLink: true,
  });
  return options.allowContinue ? result.response === 0 : false;
});

/* ------------------------------------------------------------------ */
/* Parse & Sync Timing                                                 */
/* ------------------------------------------------------------------ */
ipcMain.handle("core:readStandaloneChart", async (_e, { filePath, kind }) => {
  if (kind !== "bms" && kind !== "osu") throw new Error("Unsupported chart kind");
  return readStandaloneChart(filePath, kind);
});

ipcMain.handle("core:readOsuPreview", async (_e, { osuPath, bmsPath }) => {
  try { return await readOsuPreview(osuPath, bmsPath); } catch { return null; }
});

ipcMain.handle("core:parseMapData", async (_e, { bmsPath, osuPath }) => {
  try {
    const target = await readOsuPreview(osuPath, bmsPath);
    const { osuAudioPath, timingPoints } = target;
    const osuMeta = target.metadata;
    const fsSource = new NodeFileSource();
    const parser = new BmsFileParser();
    const bms = await parser.parse(fsSource, bmsPath);
    const bmsMeta = {
      title: (bms.header.title ?? "").trim(),
      artist: (bms.header.artist ?? "").trim(),
    };
    const timingEngine = new BmsTimingEngine();
    const timing = timingEngine.build(bms);
    // Preserve each sound's exact BMS structural position. The renderer uses
    // this as a deep resnap fallback when the selected osu! difficulty has no
    // hitobject at that musical position. Keeping the rational position avoids
    // re-guessing subdivisions from already-rounded milliseconds.
    const notes = bms.notes
      .map((n: any) => {
        const audio = bms.audio.get(n.value);
        if (!audio || !["exact", "case-insensitive", "extension-swap"].includes(audio.status)) return null;
        return {
          timeMs: timing.toMs(Number(n.measure), n.position),
          wavId: n.value,
          lane: 0,
          isBgm: n.kind === "bgm" || n.kind === "invisible",
          measure: Number(n.measure),
          positionNum: Number(n.position.num),
          positionDen: Number(n.position.den),
          measureLength: Math.max(0.01, Number(bms.measureLengths.get(Number(n.measure)) ?? 1)),
        };
      })
      .filter((n: any) => n !== null)
      .sort((a: any, b: any) => a.timeMs - b.timeMs || a.wavId.localeCompare(b.wavId));

    const baseDir = path.dirname(bmsPath);
    const files: Record<string, string> = {};
    for (const [id, filename] of bms.header.wav.entries()) {
      files[id] = path.join(baseDir, filename);
    }

    // A native BMS beat grid. This is intentionally separate from the target
    // osu timing and is offered only as an alternate metronome source. It uses
    // the BMS timing engine (including BPM changes and STOP integration).
    let maxMeasure = 0;
    for (const n of bms.notes) maxMeasure = Math.max(maxMeasure, Number(n.measure));
    for (const c of bms.bpmChanges) maxMeasure = Math.max(maxMeasure, Number(c.measure));
    for (const s of bms.stops) maxMeasure = Math.max(maxMeasure, Number(s.measure));
    const bmsBeatTimes: number[] = [];
    for (let m = 0; m <= maxMeasure + 1; m++) {
      const mult = Math.max(0.01, bms.measureLengths.get(m) ?? 1);
      const beatsInMeasure = Math.max(0.01, 4 * mult);
      for (let beat = 0; beat < beatsInMeasure - 1e-7; beat++) {
        const frac = beat / beatsInMeasure;
        const den = 1_000_000;
        const num = Math.round(frac * den);
        bmsBeatTimes.push(timing.toMs(m, { num, den }));
      }
    }

    return {
      notes, files, osuAudioPath, timingPoints, bmsBeatTimes,
      scrollPoints: target.scrollPoints,
      metadata: { bms: bmsMeta, osu: osuMeta },
      osuPreview: target.osuPreview,
      reuseKey: target.reuseKey,
    };
  } catch (err) {
    log(`[ERROR] Parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
});

ipcMain.handle("file:readAudio", async (_e, filePath: string) => {
  try {
    const buf = await fs.readFile(filePath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
});

/* ------------------------------------------------------------------ */
/* FFmpeg + sample export                                              */
/* ------------------------------------------------------------------ */
async function commandWorks(command: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let done = false;
    const child = spawn(command, ["-version"], { windowsHide: true });
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch {}
      finish(false);
    }, 2500);
  });
}

async function resolveFfmpeg(): Promise<string | null> {
  const envPath = process.env.FFMPEG_PATH;
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg", "ffmpeg.exe"];
  const candidates: string[] = [];
  if (envPath) candidates.push(envPath);
  const localAppData = process.env.LOCALAPPDATA;
  for (const name of names) {
    candidates.push(path.join(process.resourcesPath, name));
    candidates.push(path.join(app.getAppPath(), name));
    // In packaged builds getAppPath() is app.asar, not the executable folder.
    if (app.isPackaged) candidates.push(path.join(path.dirname(app.getPath("exe")), name));
    // winget creates command links here. Probe the absolute location so Retry
    // can succeed even when this already-running process has not picked up a
    // newly modified PATH yet.
    if (localAppData) candidates.push(path.join(localAppData, "Microsoft", "WinGet", "Links", name));
  }
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      if (await commandWorks(candidate)) return candidate;
    } catch {}
  }
  return (await commandWorks("ffmpeg")) ? "ffmpeg" : null;
}

ipcMain.handle("tools:ffmpegStatus", async () => {
  const executable = await resolveFfmpeg();
  return { available: !!executable, executable };
});

const WINGET_FFMPEG_COMMAND = "winget install --id Gyan.FFmpeg -e --source winget";

async function promptForFfmpeg(
  reason = "this feature",
): Promise<{ available: boolean; executable: string | null; command: string; copied?: boolean }> {
  let executable = await resolveFfmpeg();
  if (executable) {
    return { available: true, executable, command: WINGET_FFMPEG_COMMAND };
  }
  if (!win) {
    return { available: false, executable: null, command: WINGET_FFMPEG_COMMAND };
  }

  for (;;) {
    const result = await dialog.showMessageBox(win, {
      type: "warning",
      title: tr("FFmpeg is required"),
      message: tr("FFmpeg is required") + `: ${reason}.`,
      detail:
        tr("Install FFmpeg with Windows Package Manager, then click Retry.") + "\n\n" +
        WINGET_FFMPEG_COMMAND +
        "\n\n" + tr("You can also set FFMPEG_PATH or place ffmpeg.exe beside the installed app."),
      buttons: ["Copy winget command", "Retry", "Not now"].map(tr),
      defaultId: 1,
      cancelId: 2,
      noLink: true,
    });

    if (result.response === 0) {
      clipboard.writeText(WINGET_FFMPEG_COMMAND);
      log(`[INFO] Copied FFmpeg install command: ${WINGET_FFMPEG_COMMAND}`);
      await dialog.showMessageBox(win, {
        type: "info",
        title: tr("Command copied"),
        message: tr("The FFmpeg winget command was copied to your clipboard."),
        detail:
          tr("Paste it into Windows Terminal or PowerShell, wait for installation to finish, then click Retry or use the feature again."),
        buttons: [tr("OK")],
      });
      return {
        available: false,
        executable: null,
        command: WINGET_FFMPEG_COMMAND,
        copied: true,
      };
    }

    if (result.response === 1) {
      executable = await resolveFfmpeg();
      if (executable) {
        log(`[INFO] FFmpeg detected: ${executable}`);
        return { available: true, executable, command: WINGET_FFMPEG_COMMAND };
      }
      continue;
    }

    return { available: false, executable: null, command: WINGET_FFMPEG_COMMAND };
  }
}

ipcMain.handle("tools:ensureFfmpeg", async (_e, reason?: string) => {
  return promptForFfmpeg(reason || "audio conversion and pitch-preserving slow preview");
});

function atempoChain(rate: number): string {
  let r = Math.max(0.05, Math.min(4, Number(rate) || 1));
  const filters: string[] = [];
  while (r < 0.5 - 1e-9) { filters.push("atempo=0.5"); r /= 0.5; }
  while (r > 2 + 1e-9) { filters.push("atempo=2.0"); r /= 2; }
  filters.push(`atempo=${r.toFixed(8)}`);
  return filters.join(",");
}

/**
 * High-quality tempo-only preview processing. osu!lazer uses BASS_FX tempo
 * adjustment for tracks. In this Electron/TypeScript implementation we use
 * FFmpeg's tempo filter on complete rendered buses rather than stretching
 * individual samples. Processing both the song and the BMS keysound bus with
 * the same tempo ratio keeps them aligned at non-1x preview rates.
 */
ipcMain.handle("preview:tempoAudio", async (_e, { wavBytes, rate }: { wavBytes: Uint8Array; rate: number }) => {
  let executable = await resolveFfmpeg();
  if (!executable) executable = (await promptForFfmpeg("pitch-preserving slow preview")).executable;
  if (!executable) {
    return { ok: false, error: `FFmpeg is required. Install it with: ${WINGET_FFMPEG_COMMAND}` };
  }
  const safeRate = Math.max(0.25, Math.min(2, Number(rate) || 1));
  if (Math.abs(safeRate - 1) < 1e-6) return { ok: true, bytes: wavBytes };

  const dir = await fs.mkdtemp(path.join(app.getPath("temp"), "bms2osu-tempo-"));
  const input = path.join(dir, "input.wav");
  const output = path.join(dir, "output.wav");
  try {
    await fs.writeFile(input, Buffer.from(wavBytes));
    await runFfmpeg(executable, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", input,
      "-filter:a", atempoChain(safeRate),
      "-c:a", "pcm_s16le",
      output,
    ]);
    const out = await fs.readFile(output);
    return { ok: true, bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }
});



/** Tempo-process the song and rendered hitsound bus as one 4-channel stream.
 * This is the important alignment path: one tempo transform means both layers
 * receive exactly the same time warp instead of two content-dependent stretches. */
ipcMain.handle("preview:tempoPair", async (_e, { targetWavBytes, hitsoundWavBytes, rate }: { targetWavBytes: Uint8Array; hitsoundWavBytes: Uint8Array; rate: number }) => {
  let executable = await resolveFfmpeg();
  if (!executable) executable = (await promptForFfmpeg("aligned pitch-preserving slow preview")).executable;
  if (!executable) {
    return { ok: false, error: `FFmpeg is required. Install it with: ${WINGET_FFMPEG_COMMAND}` };
  }
  const safeRate = Math.max(0.25, Math.min(2, Number(rate) || 1));
  const dir = await fs.mkdtemp(path.join(app.getPath("temp"), "bms2osu-tempo-pair-"));
  const target = path.join(dir, "target.wav");
  const keys = path.join(dir, "keys.wav");
  const output = path.join(dir, "paired.wav");
  try {
    await Promise.all([
      fs.writeFile(target, Buffer.from(targetWavBytes)),
      fs.writeFile(keys, Buffer.from(hitsoundWavBytes)),
    ]);
    await runFfmpeg(executable, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", target, "-i", keys,
      "-filter_complex", `[0:a]aformat=channel_layouts=stereo[a0];[1:a]aformat=channel_layouts=stereo[a1];[a0][a1]amerge=inputs=2,${atempoChain(safeRate)}[out]`,
      "-map", "[out]", "-c:a", "pcm_s16le", output,
    ]);
    const out = await fs.readFile(output);
    return { ok: true, bytes: new Uint8Array(out.buffer, out.byteOffset, out.byteLength) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch {}
  }
});
interface SampleExportItem {
  wavId: string;
  sourcePath: string;
}

interface SampleExportOptions {
  enabled: boolean;
  convertToOgg: boolean;
  oggQuality: number;
  conflict: "replace" | "skip";
}

async function runFfmpeg(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stderr = "";
    child.stderr?.on("data", data => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

ipcMain.handle("core:prepareSamples", async (_e, payload: {
  osuPath: string;
  items: SampleExportItem[];
  options: SampleExportOptions;
}) => {
  const { osuPath, items, options } = payload;
  try {
    if (!options.enabled) {
      return {
        ok: true,
        exported: 0,
        skipped: 0,
        filenames: Object.fromEntries(items.map(item => [item.wavId, path.basename(item.sourcePath)])),
        warning: "Sample export disabled. The generated .osu will reference source filenames, which must already exist beside the target beatmap.",
      };
    }

    const outDir = path.dirname(osuPath);
    let ffmpeg = options.convertToOgg ? await resolveFfmpeg() : null;
    if (options.convertToOgg && !ffmpeg) {
      ffmpeg = (await promptForFfmpeg("OGG sample export")).executable;
    }
    if (options.convertToOgg && !ffmpeg) {
      return { ok: false, error: `FFmpeg is required. Install it with: ${WINGET_FFMPEG_COMMAND}` };
    }

    const quality = Math.max(-1, Math.min(10, Number(options.oggQuality) || 3));
    const filenames: Record<string, string> = {};
    const reserved = new Map<string, string>();
    let exported = 0;
    let skipped = 0;

    for (const item of items) {
      const originalBase = path.basename(item.sourcePath);
      const parsed = path.parse(originalBase);
      let candidate = options.convertToOgg ? `${parsed.name}.ogg` : originalBase;
      const key = candidate.toLowerCase();
      const already = reserved.get(key);
      if (already && path.resolve(already) !== path.resolve(item.sourcePath)) {
        candidate = options.convertToOgg
          ? `${parsed.name}_WAV${item.wavId}.ogg`
          : `${parsed.name}_WAV${item.wavId}${parsed.ext}`;
      }
      reserved.set(candidate.toLowerCase(), item.sourcePath);
      filenames[item.wavId] = candidate;

      const dest = path.join(outDir, candidate);
      let exists = false;
      try { await fs.access(dest); exists = true; } catch {}
      if (exists && options.conflict === "skip") {
        skipped++;
        continue;
      }

      if (options.convertToOgg) {
        await runFfmpeg(ffmpeg!, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", item.sourcePath,
          "-vn", "-c:a", "libvorbis", "-q:a", String(quality),
          dest,
        ]);
      } else {
        if (path.resolve(item.sourcePath) !== path.resolve(dest)) {
          await fs.copyFile(item.sourcePath, dest);
        }
      }
      exported++;
    }

    return { ok: true, exported, skipped, filenames };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

interface CompositeSampleItem {
  key: string;
  sourcePaths: string[];
}

ipcMain.handle("core:prepareCompositeSamples", async (_e, payload: {
  osuPath: string;
  items: CompositeSampleItem[];
  options: SampleExportOptions;
}) => {
  const { osuPath, items, options } = payload;
  try {
    if (!items.length) return { ok: true, exported: 0, skipped: 0, filenames: {} as Record<string, string> };
    let ffmpeg = await resolveFfmpeg();
    if (!ffmpeg) {
      ffmpeg = (await promptForFfmpeg("mixing overflow keysounds into one playable composite sample")).executable;
    }
    if (!ffmpeg) {
      return {
        ok: false,
        error: `A composite keysound is required and FFmpeg is missing. Install it with: ${WINGET_FFMPEG_COMMAND}`,
      };
    }

    const outDir = path.dirname(osuPath);
    const quality = Math.max(-1, Math.min(10, Number(options.oggQuality) || 3));
    const filenames: Record<string, string> = {};
    let exported = 0;
    let skipped = 0;

    for (const item of items) {
      if (item.sourcePaths.length < 2) continue;
      const safeKey = item.key.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 96);
      const ext = options.convertToOgg ? ".ogg" : ".wav";
      const filename = `bmsmix_${safeKey}${ext}`;
      filenames[item.key] = filename;
      const dest = path.join(outDir, filename);
      let exists = false;
      try { await fs.access(dest); exists = true; } catch {}
      if (exists && options.conflict === "skip") {
        skipped++;
        continue;
      }

      const args: string[] = ["-hide_banner", "-loglevel", "error", "-y"];
      for (const source of item.sourcePaths) args.push("-i", source);
      const labels = item.sourcePaths.map((_, i) => `[${i}:a]`).join("");
      args.push(
        "-filter_complex", `${labels}amix=inputs=${item.sourcePaths.length}:duration=longest:normalize=0,alimiter=limit=0.97[a]`,
        "-map", "[a]", "-vn",
      );
      if (options.convertToOgg) {
        args.push("-c:a", "libvorbis", "-q:a", String(quality));
      } else {
        // Multiple source formats cannot remain "original" as one file. WAV is
        // used as the lossless composite fallback.
        args.push("-c:a", "pcm_s16le");
      }
      args.push(dest);
      await runFfmpeg(ffmpeg, args);
      exported++;
    }

    return {
      ok: true, exported, skipped, filenames,
      warning: !options.convertToOgg && items.length ? "Overflow composites were mixed to WAV because multiple source samples cannot be preserved as one original-format file." : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

function stripConvertedStoryboardSamples(osuText: string, names: string[]): { text: string; removed: number } {
  if (!names.length) return { text: osuText, removed: 0 };
  const stem = (name: string) => path.parse(path.basename(name.replace(/\\/g, "/"))).name.toLowerCase();
  const wanted = new Set(names.map(stem));
  let removed = 0;
  const lines = osuText.split(/\r?\n/);
  const out = lines.filter(line => {
    const m = line.match(/^\s*Sample\s*,[^,]*,[^,]*,\s*"?([^",]+)"?/i);
    if (!m) return true;
    if (!wanted.has(stem(m[1]))) return true;
    removed++;
    return false;
  });
  return { text: out.join("\n"), removed };
}

/* ------------------------------------------------------------------ */
/* Write Final .osu Clone                                              */
/* ------------------------------------------------------------------ */
ipcMain.handle("core:writeOsu", async (_e, { osuPath, hitObjects, keys, removeStoryboardSampleNames = [] }) => {
  try {
    const osuText = await fs.readFile(osuPath, "utf-8");
    const stripped = stripConvertedStoryboardSamples(osuText, removeStoryboardSampleNames);
    if (stripped.removed) log(`[INFO] Removed ${stripped.removed} converted BMS sample events from the target storyboard; those sounds are now attached to playable hitobjects.`);
    let newText = stripped.text.replace(/^Version:.*$/m, `Version: Keysounds ${keys}K`);
    if (newText.match(/^CircleSize:.*$/m)) {
      newText = newText.replace(/^CircleSize:.*$/m, `CircleSize:${keys}`);
    } else {
      newText = newText.replace(/\[Difficulty\]\r?\n/, `[Difficulty]\nCircleSize:${keys}\n`);
    }

    const hoIndex = newText.indexOf("[HitObjects]");
    let before = hoIndex !== -1 ? newText.slice(0, hoIndex) : newText + "\n";
    before = before.trim() + "\n\n[HitObjects]\n";
    const finalOsu = before + hitObjects.join("\n") + "\n";
    const outPath = osuPath.replace(/\.osu$/i, ` [Keysounds ${keys}K].osu`);
    await fs.writeFile(outPath, finalOsu, "utf-8");
    return { ok: true, outPath };
  } catch (err) {
    log(`[ERROR] Writing failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
