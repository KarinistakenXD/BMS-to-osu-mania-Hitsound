# BMS to osu!mania Hitsound

Turn BMS keysounds into fully playable osu!mania hitsound maps with automatic audio alignment, resnapping, preview, and export.

## Download

For normal use, download the latest **Windows installer (.exe) from GitHub Releases**.

You do **not** need Node.js, npm, or the GitHub source-code ZIP to run a release build. The automatically generated **Source code (zip)** and **Source code (tar.gz)** links on GitHub are for developers; they are not precompiled applications.

> **Windows SmartScreen:** current releases are not code-signed, so Windows may show an "Unknown publisher" warning. The complete source and Windows build workflow are public in this repository.

## What is BMS?

**BMS (Be-Music Source)** is a family of community rhythm-game chart formats built around keysounded music.

Unlike a typical osu!mania beatmap, a BMS chart does not necessarily rely on one finished/mastered song file. A chart can define many small audio files through entries such as `#WAVxx`, then trigger those samples at musical positions. In practice, a BMS chart can reconstruct a large part of the song from hundreds or thousands of separately timed keysounds.

That difference is the main reason this converter exists: osu!mania normally plays one song file while hitobjects optionally trigger hitsounds, whereas BMS can treat the keysounds themselves as the arrangement.

Common BMS-family extensions include `.bms`, `.bme`, `.bml`, `.pms`, and `.bmx`. BMS has accumulated many extensions over time, and different players/editors do not necessarily implement every feature identically.

Useful BMS references and tools:

- [bemusic/bmspec](https://github.com/bemusic/bmspec) — executable/documented BMS-format behavior plus links to other format references.
- [beatoraja](https://github.com/exch-bms2/beatoraja) — open-source BMS player.
- [iBMSC](https://github.com/aqtq314/iBMSC) — graphical BMS creator/editor.

## What this program does

This is specifically for building an **osu!mania hitsound difficulty**. It is not intended to be a normal gameplay BMS → osu!mania chart converter.

The converter:

1. parses BMS/BME timing, BPM changes, STOPs, measure-length changes, BGM/invisible events, long-note-related data, and `#WAV` mappings;
2. reconstructs a BMS audio reference from the chart's keysounds;
3. aligns that reference to the selected osu! song audio instead of assuming both files start at the same physical sample;
4. maps BMS events into target-osu! time;
5. resnaps using target hitobjects when they are rhythmically trustworthy, then native BMS measure/fraction timing when the selected target difficulty is sparse;
6. places every audible BMS layer into a playable mania field;
7. exports the custom samples and a generated `.osu` hitsound difficulty.

The target osu! difficulty can be lower-key, such as 4K. It is timing/reference evidence; it does **not** need to contain every rhythm that exists in the BMS.

## Related osu! tools

- [osu!](https://osu.ppy.sh/) — use the editor to inspect and listen to the generated difficulty.
- [Mapset Verifier](https://github.com/Naxesss/MapsetVerifier) — useful for checking quantifiable issues such as unsnapped or concurrent hitobjects. This project uses its warnings heavily during regression testing, but verifier output should still be reviewed with mapper judgement.
- [osu-framework](https://github.com/ppy/osu-framework) — useful reference for osu!lazer's audio architecture. In particular, `TrackBass` uses BASS_FX tempo processing for pitch-preserving track-speed changes.

## Main features

- Audio-based BMS ↔ osu! alignment rather than simply adding the first red timing-point offset.
- Constant-offset and drift-aware synchronization.
- Three-state BMS/`.osu` pair verification: **Verified**, **Uncertain**, or **Clearly incompatible**.
- Deep resnapping:
  - compatible target-`.osu` hitobject first;
  - exact native BMS measure/fraction fallback;
  - validated target timing-grid fallback;
  - synchronized audio position when no snap is trustworthy.
- Automatic output key count up to 18K based on lane demand and the near-concurrent safety window.
- All audible BMS sounds are converted into the playable note field by design.
- Composite samples for unavoidable overflow instead of dumping sounds into storyboard samples or creating duplicate concurrent circles.
- Original-format sample copy or OGG Vorbis export.
- Seekable full-song waveform preview.
- Converted-BMS, target-osu!, and overlay comparison modes.
- Fixed 18K physical preview-lane width so lower-key target maps stay centered instead of stretching across the full preview.
- Note-preview speed 15–40, approximately 765 ms down to 287 ms of approach time.
- Notes disappear exactly at the NOW/judgement line, with only a small pre-hit glow.
- Visual metronome with meter/beat indicators.
- `bms!` logo BPM pulse and click-particle gimmick.
- Spacebar play/pause.
- Independent song and hitsound preview volume.

## Slow preview and FFmpeg

Preview audio is prepared after analysis and when preview mode, resnap settings,
or rate changes. Play and Pause reuse prepared audio for unchanged inputs.
The button shows Preparing while a new bus or tempo transform is being built.
Prepared rates are retained until the analyzed files or relevant settings change.
The song and keysounds still share the same four-channel FFmpeg transform at
non-1x rates; volume, seeking, and metronome changes reuse that audio.

Non-1x preview is treated as one shared timing problem.

osu!lazer uses BASS/BASS_FX tempo processing for track-speed changes rather than simple sample-rate resampling. This project does not bundle BASS, so slowed preview uses **FFmpeg**.

The complete converted BMS hitsound arrangement is rendered as one bus. That bus and the target osu! audio are passed through the same tempo transform so both layers receive the same time warp. This avoids the earlier problem where the song slowed down while short BMS samples remained effectively independent and drifted out of alignment.

If FFmpeg is missing, the app shows an install dialog instead of silently using the old low-quality fallback. On Windows it provides a copyable command:

```powershell
winget install --id Gyan.FFmpeg -e --source winget
```

The dialog can retry detection after installation. The app checks:

1. `FFMPEG_PATH`;
2. FFmpeg beside the packaged application/resources;
3. WinGet's local command-link directory;
4. the system `PATH`.

FFmpeg is required for:

- pitch-preserving non-1x preview;
- OGG sample conversion;
- mixing composite overflow keysounds.

Normal 1.00x preview and analysis can still run without it.

Audio implementation references:

- [osu-framework TrackBass.cs](https://github.com/ppy/osu-framework/blob/master/osu.Framework/Audio/Track/TrackBass.cs)
- [osu-framework audio documentation](https://github.com/ppy/osu-framework/wiki/Playing-audio)

## Typical workflow

1. Select the source BMS/BME chart.
2. Select the target osu!mania `.osu` difficulty.
3. Run **Analyze & synchronize**.
4. If pair verification is uncertain, review the measured checks and decide whether the unusual/remastered pair is intentional.
5. Inspect the waveform and note preview.
6. Compare **Converted BMS**, **Target osu!**, or **Overlay**.
7. Preview timing/audio, optionally at a slower rate with FFmpeg installed.
8. Choose sample-export options.
9. Convert the difficulty and export samples.
10. Open the result in osu! and run Mapset Verifier before treating it as rank-ready.

## Timing / resnap model

BMS mathematical timing and audio alignment are deliberately separate:

```text
BMS measure/fraction timing
        ↓
absolute BMS event timeline
        ↓
rendered BMS audio reference
        ↓
match against target osu! audio
        ↓
BMS → target time mapping
        ↓
validated target/native-phase resnap
        ↓
automatic lane allocation / composites
        ↓
playable custom-sample hitobjects
```

The converter intentionally does **not** assume that `BMS time + first osu! red point` is sufficient. Independently cut/mastered audio can contain different leading silence, transient placement, offsets, or small drift.

## Building from source (developers)

Most users should use the **.exe from Releases**. This section is only for contributors or people who want to inspect or modify the source.

Requirements:

- Node.js 22 recommended;
- npm;
- Windows for building the Windows installer;
- FFmpeg for the audio features described above.

Clone the repository, then:

```bash
npm install
npm start
```

Build the Windows x64 installer locally:

```bash
npm run dist:win
```

The installer is written to `release/`.

There is deliberately no separate `RUN_APP.bat` launcher in the repository. `npm start` is the development path; the installed `.exe` is the normal user path.

## Automated Windows builds

The repository's GitHub Actions workflow builds the Windows x64 NSIS installer on:

- pushes to `main` — produces a downloadable Actions artifact;
- manual workflow runs;
- tags matching `v*`.

A version tag such as `v1.0.0` also publishes the generated installer to GitHub Releases automatically.

## Repository structure

```text
electron/
  main.ts       Electron window, dialogs, FFmpeg, file I/O
  preload.ts    context-isolated IPC bridge
renderer/
  index.html    interface
  renderer.ts   conversion workflow, preview, transport, note display
  audio-sync.ts audio feature extraction and BMS ↔ osu! time mapping
src/core/
  bms-parser.ts
  bms-timing.ts
  bms-osu-core.ts
  node-io.ts
  osu-writer.ts
build/
  icon.ico      Windows application / installer icon
```

## Status

This converter is still experimental. Listen through the generated map and run Mapset Verifier before using the output in a serious or ranked mapset. BMS implementations can vary, and timing/hitsound judgement should still be done by a mapper.
