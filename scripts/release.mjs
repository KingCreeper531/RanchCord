// Publishes a new version: sets the version number everywhere, commits, tags and pushes.
// GitHub then builds the Windows, Android and iPhone apps (.github/workflows/release.yml), the
// Windows app updates itself, and the Raspberry Pi picks up the new server overnight.
// Usage: npm run release 1.2.0
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run release 1.2.0');
  process.exit(1);
}

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
if (git('status', '--porcelain')) {
  console.error('Commit or stash your changes first, then run this again.');
  process.exit(1);
}
if (git('tag', '--list', `v${version}`)) {
  console.error(`v${version} already exists. Pick a higher number.`);
  process.exit(1);
}

for (const file of ['package.json', 'client/package.json', 'server/package.json', 'desktop/package.json']) {
  const p = path.join(root, file);
  const json = JSON.parse(fs.readFileSync(p, 'utf8'));
  json.version = version;
  fs.writeFileSync(p, `${JSON.stringify(json, null, 2)}\n`);
}
const cargoToml = path.join(root, 'desktop/src-tauri/Cargo.toml');
fs.writeFileSync(cargoToml, fs.readFileSync(cargoToml, 'utf8').replace(/^version = ".*"$/m, `version = "${version}"`));
const cargoLock = path.join(root, 'desktop/src-tauri/Cargo.lock');
if (fs.existsSync(cargoLock)) {
  fs.writeFileSync(cargoLock, fs.readFileSync(cargoLock, 'utf8').replace(/(name = "ranchcord"\nversion = )".*"/, `$1"${version}"`));
}

git('add', '-A');
git('commit', '-m', `Release v${version}`);
git('tag', `v${version}`);
git('push');
git('push', 'origin', `v${version}`);
console.log(`Released v${version}. GitHub is building the apps now: ${git('remote', 'get-url', 'origin').replace(/\.git$/, '')}/actions`);
