const fs=require('fs'), vm=require('vm'), ts=require('typescript'), assert=require('assert/strict');
const syncApi={}; vm.runInNewContext(ts.transpile(fs.readFileSync('renderer/audio-sync.ts','utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}), {exports:syncApi, Float32Array, Map, Math, Error});
function buffer(seconds, fn) { const sampleRate=1000; const data=Float32Array.from({length:seconds*sampleRate},(_,i)=>fn(i/sampleRate)); return {sampleRate,length:data.length,duration:seconds,numberOfChannels:1,getChannelData:()=>data}; }
const sample=buffer(5,t=>.1*Math.pow(Math.sin(Math.PI*t/5),2)*(1+.3*Math.sin(t*2.3)));
const events=[1000,9000,17000,28000,42000,59000,72000].map(timeMs=>({timeMs,wavId:'01'}));
const shift=380;
const target=buffer(80,t=>events.reduce((sum,e)=> {const x=t-(e.timeMs+shift)/1000;return sum+(x>=0&&x<5?sample.getChannelData(0)[Math.floor(x*1000)]:0)},0));
const compact=syncApi.analyseBuffer(sample);
assert(!('getChannelData' in compact));assert(compact.energy.length<=sample.length/20+1);
const result=syncApi.synchronizeBmsToOsu(events,new Map([['01',compact]]),target);
console.log(result.method,result.offsetMs,result.confidence,result.residualMs);
assert(Math.abs(result.offsetMs-shift)<25,'ambient offset');
const mapping={...result,scale:1.002,offsetMs:100,manualCorrectionMs:-17};
assert.equal(syncApi.mapBmsTime(1000,mapping),1085); mapping.manualCorrectionMs=23;assert.equal(syncApi.mapBmsTime(1000,mapping),1125);
const driftScale=1.0012;
const driftTarget=buffer(82,t=>events.reduce((sum,e)=>{const x=(t-shift/1000)/driftScale-e.timeMs/1000;return sum+(x>=0&&x<5?sample.getChannelData(0)[Math.floor(x*1000)]:0)},0));
const drift=syncApi.synchronizeBmsToOsu(events,new Map([['01',compact]]),driftTarget);
console.log('drift',drift.mode,drift.scale,drift.offsetMs,drift.residualMs);
assert.equal(drift.mode,'affine');assert(Math.abs(drift.scale-driftScale)<.0005);
const silence=buffer(10,()=>0);const silent=syncApi.synchronizeBmsToOsu(events,new Map([['01',compact]]),silence);assert.equal(silent.confidence,0,'silence never earns audio confidence');
const large = new Map(); for (let i=0;i<2500;i++) large.set(String(i),syncApi.analyseBuffer(sample));
assert.equal(large.size,2500); for (const feature of large.values()) { assert(!('getChannelData' in feature)); assert(feature.energy.byteLength < sample.length * 4 / 10); }
console.log('PASS: compact features, ambient offset, affine nudge order, silent-target confidence');


