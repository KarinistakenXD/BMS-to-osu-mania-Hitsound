/**
 * renderer/bms2osu.d.ts
 * Ambient typing for the API exposed by electron/preload.ts's contextBridge.
 */
import type { Bms2OsuApi } from "../electron/preload";

declare global {
  interface Window {
    bms2osu: Bms2OsuApi;
  }
}

export {};
