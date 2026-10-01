import { contextBridge, ipcRenderer } from "electron";

const api = {
  selectBms: () => ipcRenderer.invoke("dialog:selectBms"),
  selectOsu: () => ipcRenderer.invoke("dialog:selectOsu"),
  showPairCheckDialog: (options: {
    kind: "warning" | "error";
    title: string;
    message: string;
    detail: string;
    allowContinue: boolean;
  }) => ipcRenderer.invoke("dialog:pairCheck", options),
  parseMapData: (bmsPath: string, osuPath: string) =>
    ipcRenderer.invoke("core:parseMapData", { bmsPath, osuPath }),
  readAudioFile: (filePath: string) =>
    ipcRenderer.invoke("file:readAudio", filePath),
  ffmpegStatus: () => ipcRenderer.invoke("tools:ffmpegStatus"),
  ensureFfmpeg: (reason?: string) => ipcRenderer.invoke("tools:ensureFfmpeg", reason),
  tempoAudio: (wavBytes: Uint8Array, rate: number) =>
    ipcRenderer.invoke("preview:tempoAudio", { wavBytes, rate }),
  tempoPair: (targetWavBytes: Uint8Array, hitsoundWavBytes: Uint8Array, rate: number) =>
    ipcRenderer.invoke("preview:tempoPair", { targetWavBytes, hitsoundWavBytes, rate }),
  prepareSamples: (
    osuPath: string,
    items: Array<{ wavId: string; sourcePath: string }>,
    options: {
      enabled: boolean;
      convertToOgg: boolean;
      oggQuality: number;
      conflict: "replace" | "skip";
    },
  ) => ipcRenderer.invoke("core:prepareSamples", { osuPath, items, options }),
  prepareCompositeSamples: (
    osuPath: string,
    items: Array<{ key: string; sourcePaths: string[] }>,
    options: { enabled: boolean; convertToOgg: boolean; oggQuality: number; conflict: "replace" | "skip" },
  ) => ipcRenderer.invoke("core:prepareCompositeSamples", { osuPath, items, options }),
  writeOsuFile: (osuPath: string, hitObjects: string[], keys: number, removeStoryboardSampleNames: string[] = []) =>
    ipcRenderer.invoke("core:writeOsu", { osuPath, hitObjects, keys, removeStoryboardSampleNames }),
  onLog: (cb: (line: string) => void) => {
    ipcRenderer.on("log", (_e, line: string) => cb(line));
  },
};

export type Bms2OsuApi = typeof api;
contextBridge.exposeInMainWorld("bms2osu", api);
