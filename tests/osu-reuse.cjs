const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const moduleSource = fs.readFileSync('src/core/osu-preview.ts', 'utf8');
const exportsObject = {};
vm.runInNewContext(ts.transpileModule(moduleSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  { exports: exportsObject, require });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bms-osu-reuse-'));
(async () => {
  fs.writeFileSync(path.join(dir, 'song.wav'), 'original song');
  fs.writeFileSync(path.join(dir, 'chart.bms'), '#TITLE Song');
  const text = `[General]\nAudioFilename: song.wav\nMode: 3\n[Metadata]\nTitle: Song\nArtist: Artist\nVersion: Easy\n[Difficulty]\nCircleSize: 4\n[TimingPoints]\n0,500,4,1,0,100,1,0\n1000,-50,4,1,0,100,0,0\n[HitObjects]\n64,192,500,128,0,1500:0:0:0:0:\n`;
  const write = (name, content) => { const file = path.join(dir, name); fs.writeFileSync(file, content); return file; };
  const read = file => exportsObject.readOsuPreview(file, path.join(dir, 'chart.bms'));
  const first = await read(write('easy.osu', text));
  const next = await read(write('hard.osu', text.replace('Version: Easy', 'Version: Hard').replace('CircleSize: 4', 'CircleSize: 7').replace('500,128', '700,128')));
  assert.equal(next.reuseKey, first.reuseKey, 'same song/timing reuses analysis across difficulties');
  assert.equal(next.osuPreview.keys, 7); assert.equal(next.osuPreview.notes[0].timeMs, 700); assert.equal(next.osuPreview.notes[0].endTimeMs, 1500);
  for (const change of [text.replace('Title: Song', 'Title: Other'), text.replace('Artist: Artist', 'Artist: Other'), text.replace('0,500,4', '0,600,4'), text.replace('1000,-50', '1000,-25')]) {
    assert.notEqual((await read(write('changed.osu', change))).reuseKey, first.reuseKey);
  }
  write('other.wav', 'other audio');
  assert.notEqual((await read(write('other.osu', text.replace('song.wav', 'other.wav')))).reuseKey, first.reuseKey);
  write('song.wav', 'changed audio content');
  assert.notEqual((await read(path.join(dir, 'easy.osu'))).reuseKey, first.reuseKey);
  assert.equal((await read(write('missing.osu', text.replace('song.wav', 'missing.wav')))).reuseKey, '');
  const beforeBmsChange = await read(path.join(dir, 'easy.osu'));
  write('chart.bms', '#TITLE Modified chart with new events');
  assert.notEqual((await read(path.join(dir, 'easy.osu'))).reuseKey, beforeBmsChange.reuseKey);
  console.log('PASS: difficulty reuse, updated notes/LNs, title/artist/timing/audio invalidation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
