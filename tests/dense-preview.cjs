const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),ts=require('typescript');
const source=fs.readFileSync('renderer/renderer.ts','utf8');
const state={timingPoints:[{timeMs:0,beatLength:500,meter:4}],syncedBmsBeatTimes:[],nativeViewGrids:{},standaloneKind:null};
const context=vm.createContext({state,Math,Number,$:()=>({value:'16'}),clamp:(x,a,b)=>Math.min(b,Math.max(a,x))});
function include(a,b){vm.runInContext(ts.transpile(source.slice(source.indexOf(a),source.indexOf(b)),{target:ts.ScriptTarget.ES2022}),context,{timeout:2000});}
include('function osuMetronomeTicks','/** Create a short osu!');
include('function viewDivision','$("view-division").onchange');
const run=(code)=>vm.runInContext(code,context,{timeout:2000});
assert.deepEqual(Array.from(run('osuMetronomeTicks(0,2000)'),x=>[x.timeMs,x.accent]),[[0,false],[500,false],[1000,false],[1500,false]]);
for (const meter of [3,5,6]) {
  state.timingPoints[0].meter = meter;
  const measured = run('osuMetronomeTicks(0,4000)');
  assert(measured.every(x=>!x.accent && x.meter===meter));
  assert.equal(measured[meter].beat,0);
}
// A tiny positive beat length used for SV gimmicks previously exploded both loops.
state.timingPoints=[{timeMs:0,beatLength:1e-9,meter:4},{timeMs:30000,beatLength:500,meter:4}];
assert(run('viewGridLines(0,60000)').length<=512);
const ticks=run('osuMetronomeTicks(0,60000)');
assert(ticks.length<=1200);assert(ticks.some(x=>x.timeMs===30000));
for(let i=1;i<ticks.length;i++)assert(ticks[i].timeMs-ticks[i-1].timeMs>=50-1e-6);
state.timingPoints=Array.from({length:10000},(_,i)=>({timeMs:i*.1,beatLength:.001,meter:4}));
assert(run('viewGridLines(0,1000)').length<=512);
assert(run('osuMetronomeTicks(0,1000,1.5)').length<=14);
state.syncedBmsBeatTimes=Array.from({length:10000},(_,i)=>i*.1);
assert(run('bmsMetronomeTicks(0,1000)').length<=20);
state.timingPoints=[{timeMs:0,beatLength:Infinity,meter:4},{timeMs:500,beatLength:0,meter:4}];
assert.equal(run('viewGridLines(0,1000)').length,0);assert.equal(run('osuMetronomeTicks(0,1000)').length,0);
include('function previewNoteColor','function noteY');
assert.deepEqual(Array.from({length:7},(_,i)=>run(`previewNoteColor(7,${i},"target")`)),['#ffffff','#2fc3f3','#ffffff','#ffda32','#ffffff','#2fc3f3','#ffffff']);
state.standaloneKind='bms';assert.equal(run('previewNoteColor(8,0,"target")'),'#ff855e');assert.equal(run('previewNoteColor(9,0,"target")'),'#fff0cf');
assert.equal(run('previewNoteColor(7,3,"converted")'),'#ff66ab');
console.log('PASS: extreme BPM, dense timing, finite grid work, bounded metronome density, unchanged normal beat phase, original column palettes');
const weight={style:{}},readout=vm.createContext({metronomeBpm:{},metronomeStick:{querySelector:()=>weight},metronomeBpmAt:()=>readout.bpm,currentRate:()=>readout.rate,updateBrandPulse(){},Math,Number,clamp:(x,a,b)=>Math.min(b,Math.max(a,x)),bpm:60,rate:1});
vm.runInContext(ts.transpile(source.slice(source.indexOf('function updateMetronomeReadout'),source.indexOf('function resetVisualMetronome')),{target:ts.ScriptTarget.ES2022}),readout);
const position=()=>{vm.runInContext('updateMetronomeReadout(0)',readout);return parseFloat(weight.style.top);};
const slow=position();readout.bpm=180;assert(position()>slow,'faster tempo lowers the metal weight');readout.bpm=120;const normal=position();readout.rate=.5;assert(position()<normal,'slow playback raises the weight');readout.bpm=1e15;assert(position()<=59,'extreme tempo stays on stick');
for (const bpm of [-120,.001,0,60000,Infinity,NaN]) {
  readout.bpm=bpm;
  const bounded=position();assert(Number.isFinite(bounded) && bounded>=5 && bounded<=59,'invalid/extreme BPM cannot move weight beyond stick');
}
console.log('PASS: mechanical metronome weight follows tempo, playback speed and physical visual bounds');
include('function metronomeSwingAngle','function updateVisualMetronome');
assert.equal(run('metronomeSwingAngle(0,0,500,1)'),25);
assert(Math.abs(run('metronomeSwingAngle(250,0,500,1)'))<1e-6);
assert.equal(run('metronomeSwingAngle(500,0,500,1)'),-25);
assert.equal(run('metronomeSwingAngle(500,500,600,-1)'),-25,'swing is continuous across a BPM change');
assert(Math.abs(run('metronomeSwingAngle(550,500,600,-1)'))<1e-6,'new tempo moves immediately, without CSS pause');
console.log('PASS: continuous audio-clock swing through tempo changes');
