const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('renderer/renderer.ts', 'utf8');
const section = source.slice(source.indexOf('type PreparedPreview ='), source.indexOf('async function warmPreview'));
let renders = 0, transforms = 0;
let release;
const buffer = { numberOfChannels: 4 };
const context = vm.createContext({
  Map, Promise, Math, Error,
  preparationGeneration: 1, audioCtx: {}, state: { targetAudioBuffer: buffer },
  previewMixBuffer: async () => { renders++; if (release) await release; return buffer; },
  tempoProcessedPairBuffer: async () => { transforms++; return buffer; },
  tempoProcessedBuffer: async () => buffer,
  shouldPlayTarget: mode => mode !== 'keys-only' && mode !== 'bms-reference',
  appendLog: () => {},
});
vm.runInContext(ts.transpile(section), context);
const run = code => vm.runInContext(code, context);
(async () => {
  const first = run('preparePreview("target-plus-keys", .75)');
  const second = run('preparePreview("target-plus-keys", .75)');
  assert.equal(first, second, 'concurrent Play/preparation shares one job');
  await first;
  await run('preparePreview("target-plus-keys", .75)');
  assert.equal(renders, 1); assert.equal(transforms, 1);
  await run('preparePreview("target-plus-keys", .5)');
  await run('preparePreview("target-plus-keys", .75)');
  assert.equal(transforms, 2, 'returning to a prepared rate does no tempo work');
  let unblock;
  release = new Promise(resolve => { unblock = resolve; });
  const stale = run('preparePreview("keys-only", .25)');
  run('preparationGeneration++'); unblock();
  await assert.rejects(stale, /inputs changed/);
  release = null;
  await run('preparePreview("target-plus-keys", .75)');
  assert.equal(transforms, 3, 'changed inputs prepare again');
  console.log('PASS: deduplication, cached resume, rate reuse, stale-result rejection, input invalidation');
})().catch(error => { console.error(error); process.exitCode = 1; });
