const fs=require('fs/promises'),path=require('path'),vm=require('vm'),assert=require('assert/strict'),{spawn,spawnSync}=require('child_process'),ts=require('typescript');
(async()=>{
 if (process.platform !== 'win32') { console.log('SKIP: packaged Windows FFmpeg probe'); return; }
 const found = spawnSync('where.exe', ['ffmpeg'], {encoding:'utf8',windowsHide:true});
 const ffmpeg = process.env.FFMPEG_PATH || found.stdout?.trim().split(/\r?\n/)[0];
 if (!ffmpeg) throw new Error('Install FFmpeg or set FFMPEG_PATH for this integration test');
 const source=await fs.readFile('electron/main.ts','utf8'); const section=source.slice(source.indexOf('async function commandWorks'),source.indexOf('ipcMain.handle("tools:ffmpegStatus"'));
 const root=await fs.mkdtemp(path.join(require('os').tmpdir(),'bms-ffmpeg-')),resources=path.join(root,'resources'),exe=path.join(root,'app.exe');await fs.mkdir(resources,{recursive:true});
 const proc={platform:'win32',resourcesPath:resources,env:{FFMPEG_PATH:ffmpeg,PATH:''}};
 // Exercise the actual resolver/spawn code with packaged layout inputs.
 const ctx=vm.createContext({fs,path,spawn,process:proc,app:{isPackaged:true,getAppPath:()=>path.join(resources,'app.asar'),getPath:()=>exe},setTimeout});vm.runInContext(ts.transpile(section,{target:ts.ScriptTarget.ES2022}),ctx);
 const resolve=()=>vm.runInContext('resolveFfmpeg()',ctx);
 assert.equal(await resolve(),proc.env.FFMPEG_PATH,'external FFMPEG_PATH');
 proc.env.FFMPEG_PATH=path.join(root,'missing.exe');await fs.copyFile(ffmpeg,path.join(resources,'ffmpeg.exe'));assert.equal(await resolve(),path.join(resources,'ffmpeg.exe'),'external resources, never asar');
 await fs.rename(path.join(resources,'ffmpeg.exe'),path.join(root,'ffmpeg.exe'));assert.equal(await resolve(),path.join(root,'ffmpeg.exe'),'beside packaged executable');
 await fs.rename(path.join(root,'ffmpeg.exe'),path.join(root,'probe.exe'));
 proc.env.FFMPEG_PATH=undefined;
 // Host PATH is used by real spawn; verify the final PATH fallback works here.
 assert.equal(await resolve(),'ffmpeg');
 console.log('PASS: real FFmpeg -version discovery with packaged layout: env, resources, executable folder, PATH; no asarUnpack');
})().catch(e=>{console.error(e);process.exitCode=1;});
