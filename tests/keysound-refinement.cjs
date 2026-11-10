const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');

function load(file) {
  const exports = {};
  vm.runInNewContext(ts.transpile(fs.readFileSync(file, 'utf8'), {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  }), { exports });
  return exports;
}

const { leadingTrimMs } = load('renderer/audio-sync.ts');
const { instrumentKey, UNNAMED_GROUP } = load('src/core/bms-osu-core.ts');
function audio(lengthMs, sample) {
  const channels = [0, 1].map(channel => Float32Array.from(
    { length: lengthMs * 48 }, (_, frame) => sample(frame / 48, channel),
  ));
  return { length: channels[0].length, numberOfChannels: 2, sampleRate: 48000,
    getChannelData: channel => channels[channel] };
}
assert.equal(leadingTrimMs(audio(20, () => 0)), 0);
assert.equal(leadingTrimMs(audio(20, t => .02 * Math.sin(t * 7))), 0);
const delayed = leadingTrimMs(audio(100, (t, channel) =>
  (channel ? 1 : -1) * (t < 4 ? .02 : .5) * Math.sin(t * 7)));
assert(delayed >= 2.5 && delayed <= 4, 'reject low-level oscillation and retain stereo attack');
const pickup = leadingTrimMs(audio(500, (t, channel) =>
  channel === 0 ? 0 : t < 35 ? 0 : t < 40 ? .06 : t < 350 ? 0 : .5));
assert(pickup >= 33 && pickup < 35, 'keep quiet pickup ahead of a louder sound elsewhere in the file');
assert.equal(leadingTrimMs(audio(20, () => .4)), 0, 'immediate onset stays intact');
assert.equal(leadingTrimMs(audio(120, t => (t < 60 ? .03 : .5) * Math.sin(t * 7))),
  0, 'preserve long openings with sustained low-level activity');
assert(leadingTrimMs(audio(120, t => t < 60 ? 0 : .5)) > 58,
  'a clear delayed attack can follow a long silent opening');

const events = [
  { wavId: '01', timeMs: 100 }, { wavId: '02', timeMs: 110 }, { wavId: '02', timeMs: 200 },
  { wavId: '01', timeMs: 300 }, { wavId: '02', timeMs: 300 },
  { wavId: '03', timeMs: 300 }, { wavId: '02', timeMs: 400 },
  { wavId: '04', timeMs: 300 },
];
const source = fs.readFileSync('renderer/renderer.ts', 'utf8');
const ctx = vm.createContext({
  state: { referenceEvents: events, requiredKeys: 4, sampleFamilies: new Map(), files: {
    '01': 'Pad_01.wav', '02': 'PAD_04b.ogg', '03': 'Lead_01.wav', '04': 'PAD_05.wav',
  } },
  outputEvents: () => [...events].reverse(), instrumentKey, UNNAMED_GROUP,
  clamp: (n, lo, hi) => Math.max(lo, Math.min(hi, n)),
});
vm.runInContext(ts.transpile(source.slice(source.indexOf('const MAX_OUTPUT_KEYS'),
  source.indexOf('let scrollTimelineSource')), { target: ts.ScriptTarget.ES2022 }), ctx);
const { notes } = vm.runInContext('buildConvertedPlacement(4)', ctx);
const lane = (time, wavId) => notes.find(n => n.timeMs === time && n.wavId === wavId)?.lane;
assert.equal(lane(100, '01'), lane(200, '02'), 'numbered variants share a home');
assert.equal(lane(100, '01'), lane(110, '02'), 'quick repeats stay in the home');
assert.equal(lane(200, '02'), lane(400, '02'), 'chord does not change the home');
assert.equal(lane(300, '01'), 0);
assert.equal(lane(300, '03'), 1, 'chord spill respects another active home');
assert.equal(lane(300, '02'), 2);
assert.equal(lane(300, '04'), 3);
console.log('PASS: stable family columns, protected chord spills, stereo onset and quiet pickups');
const { fingerprintSample, sampleVoiceScore, inferSampleFamilies } = load('renderer/sample-family.ts');
function pitched(frequency, partials) {
  return audio(180, (t, channel) => {
    const phase = t / 1000 * frequency * 2 * Math.PI;
    const envelope = Math.min(1, t / 8) * Math.exp(-t / 100);
    return .4 * envelope * partials.reduce((sum, level, i) => sum + level * Math.sin((i + 1) * phase), 0)
      * (channel ? .8 : 1);
  });
}
const lead = fingerprintSample(pitched(220, [1, .6, .35, .1]));
const pitchedUp = fingerprintSample(pitched(329.63, [1, .6, .35, .1]));
const different = fingerprintSample(pitched(329.63, [1, 0, .7, 0, .5]));
assert(sampleVoiceScore(lead, pitchedUp), 'pitched copies can share an audio family');
assert(!sampleVoiceScore(lead, different), 'same pitch is not evidence of the same instrument');
assert(!sampleVoiceScore(lead, fingerprintSample(audio(50, () => 0))), 'silence is not a match');

const mapped = inferSampleFamilies([
  { id: '01', nameKey: 'name:pad', fingerprint: lead },
  { id: '05', fingerprint: pitchedUp },
  { id: '06', fingerprint: different },
]);
assert.equal(mapped.get('05'), 'name:pad');
assert.equal(mapped.get('06'), 'id:06');
for (const name of ['1.wav', '1 1 2 3 4 _x2.ogg', '_3.wav', '_x2.wav', 'sample-01.ogg']) {
  assert.equal(vm.runInContext('sampleNameFamily(' + JSON.stringify(name) + ')', ctx), undefined);
}
ctx.state.sampleFamilies = mapped;
ctx.state.files['05'] = '_x2.ogg';
ctx.state.files['06'] = '3.ogg';
events.push({ wavId: '05', timeMs: 500 }, { wavId: '06', timeMs: 600 });
vm.runInContext('invalidateConvertedPlacement()', ctx);
const inferred = vm.runInContext('buildConvertedPlacement(4).notes', ctx);
assert.equal(inferred.find(n => n.wavId === '05').lane, inferred.find(n => n.wavId === '01').lane);
assert.notEqual(inferred.find(n => n.wavId === '06').lane, inferred.find(n => n.wavId === '01').lane);
console.log('PASS: opaque names use pitch-tolerant audio evidence for column grouping');

const noise = (t, channel) => .15 * Math.sin(347 * t + Math.cos(t * 23)) * (channel ? .5 : 1);
const duplicated = fingerprintSample(audio(60, noise));
const anonymous = inferSampleFamilies([
  { id: '10', fingerprint: lead },
  { id: '11', fingerprint: pitchedUp },
  { id: '12', fingerprint: duplicated },
  { id: '13', fingerprint: fingerprintSample(audio(60, noise)) },
  { id: '14' },
]);
assert.equal(anonymous.get('11'), anonymous.get('10'));
assert.equal(anonymous.get('13'), anonymous.get('12'));
assert.notEqual(anonymous.get('12'), anonymous.get('10'));
assert.equal(anonymous.get('14'), 'id:14');
const ambiguous = inferSampleFamilies([
  { id: '15', nameKey: 'name:lead', fingerprint: lead },
  { id: '16', nameKey: 'name:pad', fingerprint: lead },
  { id: '17', fingerprint: lead },
]);
assert.equal(ambiguous.get('17'), 'id:17', 'ambiguous audio keeps a separate family');
