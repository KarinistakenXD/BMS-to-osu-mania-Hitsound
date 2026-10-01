#!/usr/bin/env node
/**
 * cli.ts
 * Usage:
 *   bms2osu --bms path/to/chart.bms --target path/to/existing.osu
 *   bms2osu --bms path/to/chart.bms --out keysounds.osu
 *   bms2osu --bms path/to/chart.bms --out keysounds.osz --osz
 *
 * --keys defaults to 18 (9K + 9K). Pass --keys N to override the lane
 * distributor's totalLanes for other layouts.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  convertBms,
  defaultGrouping,
  defaultLaneOptions,
  TOTAL_LANES,
  type LaneOptions,
} from "./bms-osu-core";
import { BmsFileParser } from "./bms-parser";
import { BmsTimingEngine, BmsNoteScheduler } from "./bms-timing";
import { NodeFileSource, NodeOszSink } from "./node-io";
import { injectHitObjects, buildMinimalOsu } from "./osu-writer";

interface CliArgs {
  bms: string;
  target?: string;
  out?: string;
  osz: boolean;
  keys: number;
  title?: string;
  artist?: string;
  creator?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Partial<CliArgs> = { osz: false, keys: TOTAL_LANES };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} expects a value`);
      return v;
    };
    switch (a) {
      case "--bms":
        args.bms = next();
        break;
      case "--target":
        args.target = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--osz":
        args.osz = true;
        break;
      case "--keys":
        args.keys = Number(next());
        break;
      case "--title":
        args.title = next();
        break;
      case "--artist":
        args.artist = next();
        break;
      case "--creator":
        args.creator = next();
        break;
      default:
        if (!args.bms && !a.startsWith("--")) args.bms = a;
    }
  }

  if (!args.bms || !Number.isFinite(args.keys) || (args.keys as number) <= 0) {
    throw new Error(
      "Usage: bms2osu --bms <chart.bms> [--target existing.osu | --out out.osu[z]] " +
        "[--osz] [--keys 18] [--title T] [--artist A] [--creator C]"
    );
  }
  if (args.target && args.osz) {
    throw new Error("--target injects into an existing .osu; it can't also be zipped with --osz");
  }
  return args as CliArgs;
}

function printReport(report: Awaited<ReturnType<typeof convertBms>>): void {
  console.log(`Instrument groups: ${report.distribution.groups.length}`);
  for (const g of report.distribution.groups) {
    console.log(`  lane ${String(g.baseLane).padStart(2, " ")}  ${g.label}  (${g.noteCount} notes)`);
  }
  for (const w of report.distribution.warnings) console.warn(`  [warn] ${w}`);
  console.log(`HitObjects generated: ${report.hitObjects.length}`);
  console.log(`Shifted for collisions: ${report.shiftedCount}`);
  if (report.dropped.length > 0) {
    console.warn(
      `Dropped (>${report.distribution.groups.length ? TOTAL_LANES : 0} notes on one ms, no free lane): ${
        report.dropped.length
      }`
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const bmsPath = path.resolve(args.bms);

  console.log(`Parsing ${bmsPath} ...`);

  const source = new NodeFileSource();
  const laneOpts: LaneOptions = { ...defaultLaneOptions, totalLanes: args.keys };
  const report = await convertBms(
    source,
    bmsPath,
    { parser: new BmsFileParser(), timing: new BmsTimingEngine(), scheduler: new BmsNoteScheduler() },
    defaultGrouping,
    laneOpts
  );

  printReport(report);

  if (args.target) {
    const targetPath = path.resolve(args.target);
    const existing = await fs.readFile(targetPath, "utf-8");
    const updated = injectHitObjects(existing, report.hitObjects);
    const outPath = args.out ? path.resolve(args.out) : targetPath;
    await fs.writeFile(outPath, updated, "utf-8");
    console.log(`Injected ${report.hitObjects.length} hit objects into ${outPath}`);
    return;
  }

  const osuText = buildMinimalOsu({
    title: args.title ?? path.basename(bmsPath, path.extname(bmsPath)),
    artist: args.artist ?? "Unknown Artist",
    creator: args.creator ?? "bms2osu",
    version: `Keysounds ${args.keys}K`,
    keys: args.keys,
    hitObjects: report.hitObjects,
  });

  if (args.osz) {
    const oszPath = args.out ? path.resolve(args.out) : path.join(path.dirname(bmsPath), "keysounds.osz");
    const sink = new NodeOszSink(oszPath);
    await sink.writeText("keysounds.osu", osuText);
    await sink.finalize();
    console.log(`Wrote ${oszPath}`);
    console.log(
      "Note: this .osz contains only the generated difficulty, not the audio samples themselves " +
        "-- import it into a map that already has the BMS's .wav/.ogg files in its Songs folder."
    );
    return;
  }

  const outPath = args.out ? path.resolve(args.out) : path.join(path.dirname(bmsPath), "keysounds.osu");
  await fs.writeFile(outPath, osuText, "utf-8");
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
