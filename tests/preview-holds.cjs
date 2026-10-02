const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('renderer/renderer.ts', 'utf8');
const drawing = source.slice(source.indexOf('function previewNoteColor('), source.indexOf('function drawPlayfieldGrid('));
const context = vm.createContext({ Math, state: { standaloneKind: null }, previewScrollDistance: (a,b)=>b-a, MAX_OUTPUT_KEYS: 18, clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) });
vm.runInContext(ts.transpile(drawing), context);
function draw(timeMs, endTimeMs, nowMs, source = 'target', keys = 4) {
  const bodies = [], heads = [], colors = [];
  const ctx = { save() {}, restore() {}, beginPath() {}, fill() {}, stroke() {},
    createLinearGradient: () => ({addColorStop(at,color) { colors.push(color); }}),
    fillRect: (...args) => bodies.push(args), roundRect: (...args) => heads.push(args) };
  context.ctx = ctx; context.note = { timeMs, endTimeMs, lane: 0 }; context.nowMs = nowMs; context.source = source; context.keys = keys;
  vm.runInContext('drawPreviewNote(ctx, note, keys, source, nowMs, 500, 1, 900, 28, 342, 354)', context);
  return { bodies, heads, colors };
}
for (const source of ['target', 'converted']) {
  assert.equal(draw(1000, 3000, 900, source).heads.length, 1);
  const held = draw(1000, 3000, 2000, source);
  assert.equal(held.bodies.length, 1, 'hold survives after the head passes NOW');
  assert.equal(held.heads[0][1] + held.heads[0][3], 342, 'held head stays on judgment line');
  assert.equal(draw(1000, 3000, 3000, source).heads.length, 1, 'tail contact remains visible');
  assert.equal(draw(1000, 3000, 3001, source).heads.length, 0, 'hold disappears after release');
  assert.equal(draw(1000, 1000, 1001, source).heads.length, 0, 'tap behavior unchanged');
  assert.equal(draw(4000, 5000, 2000, source).heads.length, 0, 'future hold outside approach window hidden');
}
for (let keys=1;keys<=18;keys++) {
  const held=draw(1000,3000,2800,'target',keys);
  assert(Math.abs(held.bodies[0][2]/held.heads[0][2]-.65)<.00001, 'gray hold width consistent in '+keys+'K');
}
const tail = draw(1000, 3000, 2800);
assert.equal(tail.bodies.at(-1)[3], 1, 'original LN tail cap stays thinner than the note head');
assert(tail.bodies[0][2] < tail.heads[0][2] * .7, 'original hold body is narrower than its head');
assert(Math.abs(tail.bodies[0][2] / tail.heads[0][2] - .65) < .00001, 'gray hold body uses 65% of head width');
assert.deepEqual(tail.colors, ['#7c838f','#b7bec8','#7c838f'], 'original LN body is neutral silver, with separate colored head');
assert.equal(draw(1000,3000,2800,'converted').colors.length,0,'converted holds retain pink');
console.log('PASS: hold approach, sustained body, pinned head, release, taps, and target/overlay drawing');
