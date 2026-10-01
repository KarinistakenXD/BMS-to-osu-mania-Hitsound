/**
 * node-io.ts
 * Node.js adapters for the environment-agnostic FileSource / OutputSink
 * interfaces in bms-osu-core.ts.
 *
 * Requires (not bundled): "iconv-lite" for Shift-JIS decoding, "jszip" for
 * .osz packaging.
 *   npm install iconv-lite jszip
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import iconv from "iconv-lite";
import JSZip from "jszip";
import type { FileSource, OutputSink } from "./bms-osu-core";

/* ------------------------------------------------------------------ */
/* FileSource                                                          */
/* ------------------------------------------------------------------ */

/**
 * Paths flowing through the core/parser are forward-slash strings built by
 * joinPath()/dirOf() in bms-parser.ts, not necessarily normalized for the
 * host OS. path.normalize handles that on both POSIX and Windows.
 */
function toNativePath(p: string): string {
  return path.normalize(p);
}

export class NodeFileSource implements FileSource {
  async listFiles(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(toNativePath(dir || "."), { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      // Missing/unreadable directory: parser falls back to exists() probing.
      return [];
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(toNativePath(p));
      return true;
    } catch {
      return false;
    }
  }

  async readBinary(p: string): Promise<Uint8Array> {
    const buf = await fs.readFile(toNativePath(p));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async readText(p: string, encoding: "utf-8" | "shift_jis" = "utf-8"): Promise<string> {
    const buf = await fs.readFile(toNativePath(p));
    if (encoding === "shift_jis") return iconv.decode(buf, "shift_jis");
    // Node's default utf-8 decode silently replaces bad bytes with U+FFFD,
    // which is exactly the signal readBmsText()'s "auto" mode looks for.
    return buf.toString("utf-8");
  }
}

/* ------------------------------------------------------------------ */
/* OutputSink: plain folder                                            */
/* ------------------------------------------------------------------ */

/** Writes files straight into outDir, creating subdirectories as needed. */
export class NodeFolderSink implements OutputSink {
  constructor(private readonly outDir: string) {}

  private resolve(rel: string): string {
    return path.join(this.outDir, toNativePath(rel));
  }

  async writeText(relPath: string, data: string): Promise<void> {
    const full = this.resolve(relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data, "utf-8");
  }

  async writeBinary(relPath: string, data: Uint8Array): Promise<void> {
    const full = this.resolve(relPath);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }

  async finalize(): Promise<void> {
    /* no-op: files are already on disk */
  }
}

/* ------------------------------------------------------------------ */
/* OutputSink: .osz archive                                            */
/* ------------------------------------------------------------------ */

/** Buffers files in memory and zips them to `oszPath` on finalize(). */
export class NodeOszSink implements OutputSink {
  private readonly zip = new JSZip();

  constructor(private readonly oszPath: string) {}

  async writeText(relPath: string, data: string): Promise<void> {
    this.zip.file(relPath.replace(/\\/g, "/"), data);
  }

  async writeBinary(relPath: string, data: Uint8Array): Promise<void> {
    this.zip.file(relPath.replace(/\\/g, "/"), data);
  }

  async finalize(): Promise<void> {
    const buf = await this.zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    await fs.mkdir(path.dirname(this.oszPath), { recursive: true });
    await fs.writeFile(this.oszPath, buf);
  }
}
