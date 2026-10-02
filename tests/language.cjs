const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const catalog = { exports: {} };
vm.runInNewContext(ts.transpile(fs.readFileSync('src/core/language.ts','utf8'), {module:ts.ModuleKind.CommonJS}), catalog);
const {isLanguage, translateText, translations} = catalog.exports;
assert(isLanguage('th') && isLanguage('en') && isLanguage('zh') && !isLanguage('ja'));
for (const [english, values] of Object.entries(translations)) {
  assert(values.every(value=>value.trim()), english);
  assert.equal(translateText(english,'en'), english);
  assert.equal(translateText(english,'th'), values[0]);
  assert.equal(translateText(english,'zh'), values[1]);
}
const html = fs.readFileSync('renderer/index.html','utf8').split('<body>')[1];
const unchanged = new Set(['bms!', 'BMS to osu!mania Hitsound', 'English', 'BMS', 'osu!', '0 KPS', '— BPM']);
for (const [,text] of html.matchAll(/>([^<>]+)</g)) {
  const value = text.trim();
  if (/[a-zA-Z]{3}/.test(value)) assert(translations[value] || unchanged.has(value), 'Missing visible text: ' + value);
}
assert.equal(translateText('beat 1/3','zh'), '第 1/3 拍');
assert.equal(translateText('/songs/artist/title.osu','th'), '/songs/artist/title.osu');
assert.equal(translateText('[ERROR] fixture.wav missing','zh'), '[ERROR] fixture.wav missing');
assert(translateText('Audio prepared: 150 / 173 s of song · elapsed 15 s','th').includes('15'));
console.log('PASS: Thai/Chinese catalog, English default, visible-text coverage, progress, preserved metadata and diagnostics');
