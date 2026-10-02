# BMS to osu!mania Hitsound

Align BMS keysounds with an existing osu!mania song and export every audible BMS layer as playable custom hitsounds. You can also inspect and listen to an original BMS or osu!mania chart without converting it.

## Download

Download [the Windows x64 v1.0.4 installer](https://github.com/KarinistakenXD/BMS-to-osu-mania-Hitsound/releases/download/v1.0.4/BMS-to-osu-mania-Hitsound-Setup-1.0.4-x64.exe). Node.js and the source-code ZIP are unnecessary for normal use. Current installers are unsigned, so Windows may show an Unknown publisher warning.

## What's in v1.0.4

- Song-folder selection, compact difficulty lists, automatic hardest-difficulty selection and standalone original-chart preview. Non-mania osu! charts are rejected.
- Thai, English and Simplified Chinese controls, guidance and common dialogs. Choose **ไทย | English | 中文** at the top right; English is the initial default and your choice is remembered. Switching language keeps playback and selection. Filenames, chart metadata and raw technical diagnostics retain their original text.
- Manual Sync Correction after automatic alignment, energy-envelope fallback for low-transient audio, compact sample features and windowed preview rendering. Preview headroom protection accompanies the existing FFmpeg export limiter.
- One Play/Pause button, clear-selection crosses, elapsed preparation time, held-key lights, KPS, beat subdivisions, deliberate seeking and optional BPM/SV display.
- Original osu!mania notes use mirrored white/cyan heads and a yellow center in odd key modes. Native BMS has cream/teal/orange heads and distinct scratch colors. Original LN bodies are gray with subtle silver shading, moderately narrow at 65% of head width, with a 1px release cap. Converted hitsounds stay pink. The built-in column layout covers 1–18 lanes.
- Dense-timing protection, normalized multi-BPM scroll simulation, independent metronome volume and continuous movement through tempo changes. Compatible-difficulty analysis/audio reuse and preview speed 1–40 are retained.

See [the release notes](release-notes/v1.0.4.md) for the complete short list.

## Convert a map

1. Select the BMS song folder and an osu!mania song folder. Charts directly inside each folder appear beside **Analyze & synchronize**.
2. Choose the source and target difficulties, then analyze. The target osu! song is the default audio reference.
3. Review pair-verification diagnostics. Clearly incompatible pairs are blocked; uncertain pairs ask whether to continue.
4. Listen and compare Converted BMS, Target osu! difficulty or the overlay. Adjust timing if needed.
5. Choose sample format and existing-file behavior, then **Convert difficulty + export samples**.
6. Open the generated difficulty in osu! and inspect it before using it in a mapset.

The output is a hitsound difficulty containing all audible BMS layers, including background/invisible events. Lane allocation supports up to 18K; unavoidable simultaneous overflow becomes composite audio instead of duplicate circles or storyboard samples. Samples are written into the target beatmap folder. Names sharing one basename are disambiguated using their WAV IDs. Existing-file behavior can keep or replace files.

The target difficulty supplies timing evidence and can have fewer keys or fewer notes than the BMS. It need not contain every BMS rhythm. The exported result should still be checked by listening and with tools such as [Mapset Verifier](https://github.com/Naxesss/MapsetVerifier).

### Difficulty lists

- osu!mania: **[nK] difficulty | OD/HP: n/n**. Other osu! modes are rejected.
- BMS: keyboard key count, scratch count, difficulty and declared level. Lists sort by keyboard keys, then scratch count, then level, ascending.

BMS defaults to the highest declared PLAYLEVEL. osu! defaults use peak note density over ten seconds, then note count and OD/HP. This estimates difficulty within the folder; it is not a star rating. Manual selections are retained.

Compatible osu! difficulty changes reuse analysis when artist, title, timing data, BMS source and unchanged audio match. The displayed notes update while the analyzed timing anchors, duration and preview audio remain in use. **Analyze** explicitly updates the reference.

## Inspect one chart

Select only one song folder and click **Note preview**. BMS-family files (.bms, .bme, .bml, .bmx and .pms) display native lanes, scratches, timing and holds, with their original keysounds. osu!mania displays its original notes, holds and song.

Native key count and conversion settings are locked in this mode. The audio slider becomes **Master volume** for chart audio; metronome volume remains separate. This is a viewer, rather than a chart editor.

## Preview controls

| Control | Behavior |
| --- | --- |
| ▶ / Ⅱ or Space | Play or pause; unchanged inputs reuse prepared audio. |
| Rate | Pitch-preserving playback speed; non-1x rates require FFmpeg. |
| Scroll speed 1–40 | Changes note approach time, independently of audio rate. |
| Beat division | Visual grid and fine-seek subdivision, including 1/1 through 1/16 and triplets. |
| Hitsound sample volume | Conversion hitsound preview and generated osu! sample volume; locked in standalone mode. |
| Audio / Master volume | Target song comparison, or standalone chart audio. |
| Metronome volume | Independent 0–100% slider; zero mutes clicks and retains flashes and movement. |
| Apply source BPM / SV | Enables source scroll changes in the visual preview only. |

Left-drag the waveform or middle-drag the waveform/note area to scrub. Shift makes middle-drag finer. Ordinary wheel scrolls the page; **Alt+wheel** seeks one second and **Alt+Shift+wheel** uses the selected beat division. The held-key monitor stays lit until LN release; KPS counts note heads in a one-second window.

The metronome always follows the selected timing source. Clicks have one consistent sound, with no separate downbeat label. osu! meter values such as 3/4, 5/4 and 6/4 determine its beat display; BMS display currently assumes four beats. Beat dots follow chart timing, including beat-one resets at osu! BPM changes. The stick uses the audio clock; its metal weight follows tempo and playback rate within physical bounds.

Extreme timing is bounded to keep audio responsive: visual grids have a finite work budget and overcrowded metronome clicks are thinned to at most 20 per real second. Audio scheduling runs separately from canvas redraws.

### BPM / SV display

osu! BPM and inherited SV changes are normalized against the duration-weighted most common BPM through the final note, including LN release. Native BMS supports BPM changes, STOPs and positive SCROLL extensions. Reverse BMS scrolling and SPEED/SP spacing extensions remain unsupported and produce diagnostics. These display settings do not alter audio or exported timing.

## Synchronization and corrections

Automatic synchronization compares reconstructed BMS audio with the target song. It can use constant offset or affine drift mapping, and an energy-envelope fallback when transients are weak. Decisions use confidence, residuals and timing evidence; there is no arbitrary 75% acceptance threshold.

The order is **native BMS timing → automatic audio mapping → manual correction → optional evidence-based resnap → output lanes/composites**.

| Setting | What it changes |
| --- | --- |
| Manual Sync Correction (ms) | Shifts BMS after automatic alignment. Positive is later; negative is earlier. Notes update while typing; audio rebuilds after a short pause. |
| Base tolerance | Resnap search sensitivity. Thorough searches may expand with supporting evidence. It does not shift all audio or rerun analysis, and has no effect with resnap off. |
| Re-snap | Uses trustworthy target hitobjects, native BMS rhythmic phase and validated grid evidence. It can pull manually shifted events back toward nearby anchors. |
| Analyze & synchronize | Measures alignment again and resets manual correction to zero. |

Disable resnap to inspect the exact manual shift. Review diagnostics and listen to unusual or remastered pairs; a plausible automatic fit still needs human judgement.

## Audio preparation and FFmpeg

Analysis produces alignment evidence; preview preparation then renders the playable audio bus. Changes to timing, preview mode or playback rate may need new audio. The loading overlay covers note preview too, and progress separates **song seconds prepared** from **elapsed seconds**. Play/Pause, seeking, volume and display changes reuse unchanged audio.

Sample analysis retains compact onset/energy features rather than every decoded PCM buffer. Preview mixes short windows with a temporary decode cache and headroom protection. Full-song buses and cached tempo versions still consume memory, so arbitrarily large charts can exhaust RAM.

FFmpeg is external and is not bundled inside ASAR. Discovery validates FFMPEG_PATH, executable/resources locations, WinGet links and system PATH by running the executable. No unnecessary ASAR unpacking is added.

FFmpeg is required for non-1x preview, OGG conversion and composite overflow mixing. Normal 1x analysis/preview and original-format copying can run without it. The installation dialog offers this command and retries discovery:

~~~powershell
winget install --id Gyan.FFmpeg -e --source winget
~~~

At non-1x rates, song and hitsounds share the same tempo transform to retain alignment. Final composite export keeps the FFmpeg limiter.

## Build and validation

Use Node.js 22 and npm. Windows is required for the Windows installer.

~~~bash
npm ci
npm test
npm run typecheck:renderer
npm run build
npm start
~~~

Build the x64 NSIS installer with **npm run dist:win**; output goes into release/. Native Electron preview validation runs with **npx electron tests/preview-electron.cjs**.

The Windows workflow checks the test suites, renderer types and native Electron audio/preview behavior before building. It uploads a build artifact; tags publish releases. Successful main builds update the current package-version release and its installer, including v1.0.4 polish updates.

Source layout: electron/ contains dialogs, FFmpeg and file operations; renderer/ contains the interface, preview, synchronization and language switching; src/core/ contains parsers, timing, folder discovery, export and the shared language catalog. Tests live in tests/.

## References

- [BMS format reference](https://github.com/bemusic/bmspec), [beatoraja](https://github.com/exch-bms2/beatoraja) and [iBMSC](https://github.com/aqtq314/iBMSC).
- [osu!](https://osu.ppy.sh/) and [osu-framework audio documentation](https://github.com/ppy/osu-framework/wiki/Playing-audio).
- [R Skin bar layout](https://mania-tracker.com/skins/r-skin-v1-2-bars) inspired the mirrored osu! head colors. The gray LN treatment is drawn by this app; third-party skin assets are not bundled.
