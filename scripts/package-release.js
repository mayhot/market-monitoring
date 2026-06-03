const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const packageJsonPath = path.join(root, 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const packageName = packageJson.name;
const packageVersion = packageJson.version;

if (!packageName || !packageVersion) {
  throw new Error('package.json must define name and version before packaging.');
}

const releaseDir = path.join(root, 'release');
const outputPath = path.join(releaseDir, `${packageName}-${packageVersion}.vsix`);
const vscePath = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'vsce.cmd' : 'vsce');

fs.mkdirSync(releaseDir, { recursive: true });
fs.rmSync(outputPath, { force: true });

const result = spawnSync(vscePath, ['package', '--out', outputPath], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32'
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status || 0;
