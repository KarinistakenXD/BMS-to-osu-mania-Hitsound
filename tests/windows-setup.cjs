const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const catalog = {exports:{}};
vm.runInNewContext(ts.transpile(fs.readFileSync('src/core/language.ts','utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),catalog);
const context = {exports:{}, process, require: name=>name==='./language'?catalog.exports:require(name)};
vm.runInNewContext(ts.transpile(fs.readFileSync('src/core/windows-setup.ts','utf8'),{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}),context);
const {findOsuSongs, executableFromCommand} = context.exports;
assert.equal(executableFromCommand('"C:\\Games\\osu!\\osu!.exe" "%1"'),'C:\\Games\\osu!\\osu!.exe');
assert.equal(executableFromCommand('C:\\osu!\\osu!.exe "%1"'),'C:\\osu!\\osu!.exe');
assert.equal(executableFromCommand('not an executable'),undefined);
const {patchTemplate} = require('../build/prepare-installer.cjs');
const original = '      StrCpy $0 "$LocalAppData\\Programs"\n      System::Store S\n      System::Call dangerousWin7Helper\n      System::Store L\n      StrCpy $INSTDIR "$0\\${APP_FILENAME}"\n';
const patched = patchTemplate(original);
assert(!patched.includes('System::Store') && patched.includes('$LocalAppData\\Programs') && patched.includes('StrCpy $INSTDIR'));
assert.equal(patchTemplate(patched),patched);
assert.throws(()=>patchTemplate('unexpected template'),/review/);
const pkg = JSON.parse(fs.readFileSync('package.json','utf8'));
assert.equal(pkg.build.nsis.allowElevation,false);
assert.equal(pkg.build.nsis.selectPerMachineByDefault,false);
const installer = fs.readFileSync('build/installer.nsh','utf8');
assert(installer.includes('!macro customInstallMode\n  StrCpy $isForceCurrentInstall 1'));
assert(installer.includes('StrCpy $SetupDownloadState ${BST_UNCHECKED}'));
assert(installer.includes('${AndIf} $SetupFfmpeg == ""'), 'download only when missing');
assert(installer.includes('${If} $SetupBusy == 1'), 'repeat install transition protected');
(async()=>{
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(),'bms-setup-test-'));
  try {
    const root = path.join(temp,'osu! Thai ไทย');
    const standard = path.join(root,'Songs');
    const custom = path.join(root,'Custom maps');
    await fsp.mkdir(standard,{recursive:true}); await fsp.mkdir(custom);
    assert.equal(await findOsuSongs([root]),standard);
    await fsp.writeFile(path.join(root,'osu!.user.cfg'),'BeatmapDirectory = Custom maps\n');
    assert.equal(await findOsuSongs([root],undefined,'user'),custom);
    assert.equal(await findOsuSongs([root],standard,'user'),standard,'existing explicit choice wins');
    await fsp.writeFile(path.join(root,'osu!.user.cfg'),'BeatmapDirectory = '+standard+'\n');
    assert.equal(await findOsuSongs([root],undefined,'user'),standard,'absolute configuration path');
    assert.equal(await findOsuSongs([path.join(temp,'missing')]),undefined);
    console.log('PASS: current-user installer, guarded optional FFmpeg install, safe NSIS backport, osu registry commands and custom/default Songs folders');
  } finally {
    assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
    await fsp.rm(temp,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
