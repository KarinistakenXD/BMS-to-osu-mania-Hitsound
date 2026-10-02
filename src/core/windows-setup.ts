import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { isLanguage, type Language } from "./language";

const setupKey = "HKCU\\Software\\KarinistakenXD\\BMS-to-osu-mania-Hitsound";
export async function registryValue(key: string, value?: string): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  return new Promise(resolve => execFile("reg.exe", ["query", key, ...(value ? ["/v", value] : ["/ve"])], { windowsHide: true, timeout: 2000 }, (error, stdout) => {
    resolve(error ? undefined : stdout.match(/REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1].trim());
  }));
}
export function executableFromCommand(command: string): string | undefined {
  return command.match(/^\s*"([^"]+\.exe)"|^\s*(.+?\.exe)(?:\s|$)/i)?.slice(1).find(Boolean);
}
async function directoryExists(folder: string | undefined): Promise<boolean> {
  try { return !!folder && (await fs.stat(folder)).isDirectory(); } catch { return false; }
}
export async function findOsuSongs(roots: string[], preferred?: string, username = process.env.USERNAME): Promise<string | undefined> {
  if (await directoryExists(preferred)) return preferred;
  for (const root of [...new Set(roots)]) {
    try {
      const files = (await fs.readdir(root)).filter(file => /^osu!\..+\.cfg$/i.test(file));
      files.sort((a,b) => Number(b.toLowerCase() === `osu!.${username}.cfg`.toLowerCase()) - Number(a.toLowerCase() === `osu!.${username}.cfg`.toLowerCase()));
      for (const file of files) {
        const config = await fs.readFile(path.join(root,file), "utf8");
        const value = config.match(/^\s*BeatmapDirectory\s*=\s*(.*?)\s*$/m)?.[1];
        if (!value) continue;
        const folder = path.isAbsolute(value) ? value : path.resolve(root,value);
        if (await directoryExists(folder)) return folder;
      }
      const standard = path.join(root,"Songs");
      if (await directoryExists(standard)) return standard;
    } catch {}
  }
  return undefined;
}
export async function setupPreferences(): Promise<{ language: Language; songsFolder?: string }> {
  const [language, preferred] = await Promise.all([registryValue(setupKey,"Language"), registryValue(setupKey,"OsuSongsFolder")]);
  const keys = ["HKCU\\Software\\Classes\\osu\\shell\\open\\command", "HKCR\\osu\\shell\\open\\command", "HKCR\\osufile\\shell\\open\\command"];
  const commands = await Promise.all(keys.map(key => registryValue(key)));
  const roots = commands.flatMap(command => { const exe = command && executableFromCommand(command); return exe ? [path.dirname(exe)] : []; });
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA,"osu!"));
  return { language: isLanguage(language) ? language : "en", songsFolder: await findOsuSongs(roots,preferred) };
}
