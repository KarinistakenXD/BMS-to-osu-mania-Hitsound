# BMS to osu!mania Hitsound

A desktop Electron/TypeScript tool for converting BMS/BME keysound charts into an osu!mania **hitsound difficulty** while keeping the target osu! audio as the timing/audio reference.

The goal is not to turn a BMS chart into a normal gameplay conversion. The goal is to recover every audible BMS layer, align it to the selected osu! song, place those layers into a playable mania field, and export custom samples/hitobjects that can be used as a ranked-map hitsound difficulty.

## What the program does

- Parses BMS/BME timing, BPM changes, STOPs, measure-length changes, BGM events, invisible notes, and WAV mappings.
- Reads the selected osu!mania `.osu` difficulty and its `AudioFilename`, red timing points, meter, key count, and hitobjects.
- Renders BMS keysounds into an audio reference and aligns that reference against the target osu! audio instead of assuming the BMS and osu! files begin at the same sample.
- Supports constant offset and drift-aware synchronization.
- Re-snaps converted events after synchronization using, in order:
  1. a compatible hitobject in the selected target `.osu`,
  2. the exact native BMS measure/fraction phase,
  3. a validated target timing grid,
  4. the synchronized audio position when no safe snap exists.
- Automatically selects the minimum output key count required to avoid same-column objects inside the verifier concurrency window, up to 18K.
- Forces all audible BMS layers into the playable note field. BGM/invisible keysounds are not intentionally exported as storyboard sample events.
- Merges unavoidable overflow layers into composite custom samples instead of creating concurrent circles in one column.
- Exports samples either in their original format or as recompressed OGG Vorbis.
- Supports keep-existing or replace-existing sample behavior.
- Shows the target audio waveform, seekable full-song preview, synchronized note preview, target-difficulty overlay, metronome, meter indicator, and key activity monitor.
- Spacebar toggles preview play/pause.
- Preview audio and hitsound volumes are independent; hitsound volume is also written to the generated `.osu` hitobjects.
- Playback-rate preview supports 0.25x, 0.50x, 0.75x, and 1.00x.

## Slow-preview audio design

osu!lazer currently uses BASS/BASS_FX for track tempo adjustment. In osu-framework's `TrackBass`, the track is wrapped in a BASS_FX tempo stream and configured with a quick tempo algorithm, 4 ms overlap, and a 30 ms sequence. osu!framework samples are a separate subsystem and do not inherently provide the same track-tempo functionality.

This project does **not** bundle BASS. For non-1x preview, it uses FFmpeg tempo processing instead:

1. The target osu! audio is decoded.
2. The complete converted BMS hitsound bus is rendered at its final synchronized/resnapped positions.
3. For `osu audio + converted hitsounds`, both stereo layers are merged into one multichannel stream and passed through the **same** `atempo` transform.
4. The result is split back into song and hitsound volume buses for playback.

Using one shared time-warp is important: processing hundreds of short BMS samples independently can move transients differently and cause the slowed keysounds to drift away from the slowed song.

If FFmpeg is unavailable, the app does **not** use the old in-process slow-preview fallback. Instead it shows an install prompt with the Windows command `winget install --id Gyan.FFmpeg -e`. Slow preview is cancelled until FFmpeg is available, which avoids previewing the song and BMS hitsounds with a low-quality transform that can drift or sound broken.

References:

- osu-framework `TrackBass.cs`: https://github.com/ppy/osu-framework/blob/master/osu.Framework/Audio/Track/TrackBass.cs
- osu-framework audio documentation: https://github.com/ppy/osu-framework/wiki/Playing-audio
- osu! discussion on slower editor playback quality/synchronization: https://github.com/ppy/osu/discussions/28987

## Requirements

- Windows is the primary target for the current desktop build.
- Node.js + npm for source/development builds.
- FFmpeg is required for:
  - OGG sample conversion,
  - composite sample mixing,
  - high-quality pitch-preserving non-1x preview.

When a feature requires FFmpeg and it is missing, the app shows a modal with a **Copy winget command** button and a **Retry** button. The Windows command is:

```powershell
winget install --id Gyan.FFmpeg -e
```

FFmpeg is discovered from:

1. `FFMPEG_PATH`,
2. beside the packaged application/resources,
3. the system `PATH`.

This makes it possible to bundle `ffmpeg.exe` with a future installer.

## Running from source

Open a terminal in the project folder:

```bash
npm install
npm start
```

`npm start` rebuilds the Vite renderer and Electron TypeScript before launching.

For a faster launch after a successful build:

```bash
npm run start:fast
```

## Typical workflow

1. Click **Select BMS chart** and choose the `.bms`/`.bme` source.
2. Click **Select target .osu** and choose the osu!mania difficulty whose song/timing should be the reference.
3. Click **Analyze & synchronize**.
4. If the BMS/`.osu` pair checker is uncertain, review the detailed modal. A clearly unrelated pair is blocked; a plausible but unusual/remastered pair can be continued manually.
5. Check the waveform and note preview.
6. Use **Converted BMS**, **Target osu! difficulty**, or **Overlay comparison** to inspect placement.
7. Adjust note-preview scroll speed from 15 to 40. The approach window is approximately:
   - speed 40: 287 ms,
   - speed 15: 765 ms.
8. Preview at 1x first. Slower rates require FFmpeg so the target song and rendered BMS hitsound bus receive one shared pitch-preserving tempo transform.
9. Adjust **Audio volume** for comparison only and **Hitsound sample volume** for preview/output.
10. Choose sample output format and overwrite policy.
11. Click **Convert difficulty + export samples**.
12. Run Mapset Verifier on the generated difficulty and inspect any remaining unsnapped/concurrent-object warnings.

## Note preview

The preview uses a fixed 18K physical lane width. Lower-key target difficulties are centered rather than stretched across the entire canvas, so a 4K target is visually comparable with a 15K/18K converted hitsound field.

The judgment line is near the bottom of the preview. Notes disappear at the judgment line rather than continuing past it. A small pre-hit glow is used only as a subtle piano/key-press cue.

The **Key monitor** follows the automatically selected output keymode and flashes columns just before their converted notes reach the judgment line.

## Automatic output key count

The app estimates how many lanes are required so a lane is not reused inside the current 28 ms safety window. The output key count:

- cannot be set below the computed safe minimum,
- cannot exceed 18K,
- uses composite samples if the chart genuinely requires more simultaneous/near-simultaneous audible layers than can fit safely in 18 columns.

## Metronome

The metronome can follow:

- target osu! red timing points (default), including the timing point's meter,
- synchronized BMS-native beat timing.

The visual pendulum swings on real scheduled beats, downbeats use a stronger accent, and the meter row (`[ ] [ ] [ ] [ ]`, etc.) follows the current beat in the measure.

The `bms!` logo pulses to the effective preview BPM while playing and returns to a 60 BPM idle pulse when preview is paused/stopped. Clicking it drops decorative `bms!` particles.

## Pair verification

The pair checker intentionally has three outcomes:

- **Verified** — continue automatically.
- **Uncertain** — show the measured checks and allow manual continuation.
- **Clearly incompatible** — block preview/conversion.

Weak waveform correlation alone is not considered enough to reject a pair because BMS keysound renders and mastered/remastered osu! audio can differ substantially.

## Windows release build

The repository includes `electron-builder` configuration and a GitHub Actions workflow for Windows x64.

Build locally on Windows:

```bash
npm install
npm run dist:win
```

Release files are written to `release/` and include an NSIS installer plus a portable executable.

The GitHub workflow runs on pushes to `main`, can be started manually, and publishes build artifacts. Tags matching `v*` (for example `v1.0.0`) also create a GitHub Release with the generated `.exe` files attached.

## Repository structure

```text
electron/
  main.ts       Electron window, dialogs, file I/O, FFmpeg operations
  preload.ts    safe renderer IPC bridge
renderer/
  renderer.ts   synchronization workflow, preview, note display, transport
  audio-sync.ts audio feature extraction and BMS↔osu time mapping
  index.html    osu!web-inspired interface
src/core/
  bms-parser.ts
  bms-timing.ts
  osu-writer.ts
  node-io.ts
```

## Important design rule

BMS mathematical timing and audio synchronization are separate concerns:

```text
BMS measure/fraction timing
        ↓
absolute BMS timeline
        ↓
rendered BMS audio reference
        ↓
match against target osu! audio
        ↓
BMS → osu time mapping
        ↓
validated resnap / lane allocation
        ↓
playable custom-sample hitobjects
```

Do not replace this with `BMS time + first osu timing point`. The selected osu! timing point is useful as a rhythmic grid, but it does not by itself describe how two independently cut/mastered audio files line up.

## Status

This is still an experimental conversion/debugging tool. Always listen to the exported map and run Mapset Verifier before treating the result as rank-ready.
