const fs=require('fs'),fsp=require('fs/promises'),path=require('path'),os=require('os'),ts=require('typescript'),vm=require('vm'),assert=require('assert/strict');
require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText,file);
const {readChartFolder}=require('../src/core/chart-folder.ts'),{readOsuPreview}=require('../src/core/osu-preview.ts');
(async()=>{
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'bms-folder-'));
  try {
    await fsp.writeFile(path.join(dir,'another.bme'),'#TITLE Song [Another]\n#PLAYLEVEL 12\n#BPM 120\n#WAV01 absent.wav\n#00119:01\n');
    await fsp.writeFile(path.join(dir,'hyper.bmx'),'#TITLE Song [Hyper]\n#PLAYLEVEL 8\n#BPM 120\n#WAV01 absent.wav\n#00111:01\n');
    const mania='[General]\nMode:3\n[Metadata]\nVersion:Expert\n[Difficulty]\nCircleSize:7\nOverallDifficulty:9\n';
    await fsp.writeFile(path.join(dir,'expert.osu'),mania);
    await fsp.writeFile(path.join(dir,'dense.osu'),mania.replace('Version:Expert','Version:Dense').replace('OverallDifficulty:9','OverallDifficulty:8')+'[HitObjects]\n64,192,1000,1,0\n64,192,1200,1,0\n');
    await fsp.writeFile(path.join(dir,'standard.osu'),mania.replace('Mode:3','Mode:0'));
    await fsp.writeFile(path.join(dir,'broken.osu'),mania.replace('CircleSize:7','CircleSize:abc'));
    await fsp.mkdir(path.join(dir,'nested'));await fsp.writeFile(path.join(dir,'nested','ignored.osu'),mania);
    const bms=await readChartFolder(dir,'bms');assert.equal(bms.charts.length,2);assert.equal(bms.charts[0].keys,6);assert.equal(bms.charts[1].label,'[7K, Scratch] [Another] LV. 12');assert.equal(bms.defaultPath,bms.charts[1].path,'hardest default independent of list order');
    await fsp.writeFile(path.join(dir,'low7.bme'),'#TITLE Song [Low]\n#PLAYLEVEL 1\n#BPM 120\n#WAV01 absent.wav\n#00119:01\n');
    const grouped=await readChartFolder(dir,'bms');assert.deepEqual(grouped.charts.map(c=>[c.keyboardKeys,c.scratches,c.rank[0]]),[[5,1,8],[7,1,1],[7,1,12]]);assert.equal(grouped.defaultPath,bms.defaultPath);
    const osu=await readChartFolder(dir,'osu');assert.equal(osu.charts.length,2);assert.equal(osu.charts[0].label,"[7K] Dense | OD/HP: 8/—");assert.equal(osu.charts[1].label,'[7K] Expert | OD/HP: 9/—');assert.equal(osu.warnings.length,2);assert(osu.warnings.some(w=>w.includes('rejected')));
    await assert.rejects(readOsuPreview(path.join(dir,'standard.osu'),''),/only osu!mania/);
    const source=fs.readFileSync('renderer/renderer.ts','utf8');let reloads=0,invalidations=0,reuses=0;
    const state={bmsPath:'old.bme',osuPath:'',standaloneKind:'bms'},ctx=vm.createContext({state,chartSelectionBusy:false,difficultySelectionRequest:0,chartFolders:{bms:{charts:[{path:'new.bme'}]},osu:{charts:[{path:'new.osu'}]}},$:()=>({}),fileSummaryBms:{},fileSummaryOsu:{},reuseAnalyzedTarget:async()=>{reuses++;return true},invalidateSelectedPair(){invalidations++},checkReady(){},loadStandalonePreview:async()=>{reloads++}});
    vm.runInContext(ts.transpile(source.slice(source.indexOf('async function chooseDifficulty'),source.indexOf('for (const kind of ["bms", "osu"] as const)',source.indexOf('async function chooseDifficulty'))),{target:ts.ScriptTarget.ES2022}),ctx);
    await vm.runInContext('chooseDifficulty("bms","new.bme")',ctx);assert.equal(state.bmsPath,'new.bme');assert.equal(reloads,1);assert.equal(invalidations,1);
    state.osuPath='old.osu';state.standaloneKind=null;await vm.runInContext('chooseDifficulty("osu","new.osu")',ctx);assert.equal(reuses,1);assert.equal(invalidations,1);
    await vm.runInContext('chooseDifficulty("bms","not-in-folder.bme")',ctx);assert.equal(state.bmsPath,'new.bme');
    console.log('PASS: folder chart metadata, BME/BMX lanes/levels, mania-only rejection, direct-folder scope, standalone difficulty reload and compatible reuse');
  } finally { await fsp.rm(dir,{recursive:true,force:true}); }
})().catch(error=>{console.error(error);process.exitCode=1});
