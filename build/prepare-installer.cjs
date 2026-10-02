const fs = require('node:fs');
const path = require('node:path');

// Backport electron-builder #9564: Electron 30 supports Windows 10+, so the
// Windows 7 known-folder helper (System::Store race) is unnecessary here.
function patchTemplate(source) {
  if (source.includes('; BMS safe per-user directory')) return source;
  const block = /      System::Store S\r?\n[\s\S]*?      System::Store L\r?\n/;
  if ((source.match(/System::Store S/g) || []).length !== 1 || !block.test(source)) throw new Error('NSIS per-user template changed; review the installer backport');
  return source.replace(block, '      ; BMS safe per-user directory: use LOCALAPPDATA\\Programs on supported Windows.\n');
}
module.exports = async () => {
  const file = path.join(path.dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/multiUser.nsh');
  const source = fs.readFileSync(file, 'utf8');
  const patched = patchTemplate(source);
  if (patched !== source) fs.writeFileSync(file, patched);
};
module.exports.patchTemplate = patchTemplate;
