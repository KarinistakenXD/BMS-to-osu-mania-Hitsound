const fs=require('fs'),vm=require('vm'),ts=require('typescript'),assert=require('assert/strict');
const text=fs.readFileSync('renderer/renderer.ts','utf8');
let invalidations=0,locks=0,draws=0,scheduled=0;
const input={value:'-17'};
const state={sync:{scale:1.002,offsetMs:100},syncedEvents:[{timeMs:1102,sourceTimeMs:1000,wavId:'a'}],bmsBeatTimes:[1000],syncedBmsBeatTimes:[],referenceMixBuffer:{},tempoMixBuffers:new Map([['reference',{}]]),targetAudioBuffer:{duration:5},targetNotes:[],audioBuffers:new Map([['a',{durationMs:3000}]])};
const ctx=vm.createContext({state,Math,Number,Map,$:()=>input,stopPreview(){},mapBmsTime:(time,sync)=>time*sync.scale+sync.offsetMs+(sync.manualCorrectionMs??0),timeline:{},invalidatePreviewAudio(){invalidations++;},rebuildPhaseBeatLocks(){locks++;},drawNotePreview(){draws++;},appendLog(){},scheduleTimingPreview(){scheduled++;}});
vm.runInContext(ts.transpile(text.slice(text.indexOf('const manualSync ='), text.indexOf('function setStandaloneControls')),{target:ts.ScriptTarget.ES2022}),ctx);
input.oninput();assert.equal(draws,1);assert.equal(scheduled,1);input.onchange();assert.equal(draws,1,"blur does not repeat the edit");assert.equal(state.syncedEvents[0].timeMs,1085);assert.equal(state.syncedBmsBeatTimes[0],1085);assert.equal(state.referenceMixBuffer,null);assert.equal(state.tempoMixBuffers.size,0);
input.value='23';input.onchange();assert.equal(state.syncedEvents[0].timeMs,1125,'nudge never accumulates');assert.equal(state.sync.offsetMs,100,'automatic evidence remains unchanged');assert.equal(invalidations,2);assert.equal(locks,2);
console.log('PASS: manual nudge remaps source timestamps and beats, clears preview buses, preserves auto fit, never accumulates');

ctx.snapTolerance={};vm.runInContext(ts.transpile(text.match(/snapTolerance\.oninput = [^\n]+/)[0],{target:ts.ScriptTarget.ES2022}),ctx);ctx.snapTolerance.oninput();assert.equal(draws,3);assert.equal(scheduled,3);console.log('PASS: tolerance updates note placement immediately and queues audio preparation');
