// Builds the Android app and copies it to downloads/RanchCord.apk (friends can grab it from the server).
// Usage: npm run android:build
// Steps: build the web app, copy it into the Android project, then run Gradle.
// If your normal Gradle folder (~/.gradle) can't be written to, a private one inside the project is used,
// reading libraries you already downloaded from ~/.gradle instead of downloading them again.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const client = path.join(root, 'client');
const android = path.join(client, 'android');
const win = process.platform === 'win32';

const quote = (a) => (/[\s&()^]/.test(a) ? `"${a}"` : a);

function run(cmd, args, opts = {}) {
  const line = [cmd, ...args].map(quote).join(' ');
  console.log(`\n> ${line}`);
  // npm, npx and gradle are .cmd/.bat files on Windows, which only start through the shell.
  const res = win ? spawnSync(line, { stdio: 'inherit', shell: true, ...opts }) : spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.status !== 0) process.exit(res.status ?? 1);
}

function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.ranchcord-write-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}

if (!fs.existsSync(path.join(android, 'keystore.properties')) && !process.env.RANCHCORD_KEYSTORE) {
  console.warn('\nNo signing key found (client/android/keystore.properties). The APK will be signed with a debug key,');
  console.warn('which means updates won’t install over it later. See README → Android signing.\n');
}

run('npm', ['run', 'build'], { cwd: client });
run('npx', ['cap', 'sync', 'android'], { cwd: client });

const env = { ...process.env };
let gradle = path.join(android, win ? 'gradlew.bat' : 'gradlew');
const home = path.join(os.homedir(), '.gradle');
if (!env.GRADLE_USER_HOME && !writable(path.join(home, 'wrapper', 'dists'))) {
  env.GRADLE_USER_HOME = path.join(android, '.gradle-home');
  if (fs.existsSync(path.join(home, 'caches', 'modules-2'))) env.GRADLE_RO_DEP_CACHE = path.join(home, 'caches');
  // Reuse the Gradle version you already downloaded instead of fetching it again.
  const props = fs.readFileSync(path.join(android, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
  const version = /gradle-([\d.]+)-(?:all|bin)\.zip/.exec(props)?.[1];
  const dists = path.join(home, 'wrapper', 'dists');
  if (version && fs.existsSync(dists)) {
    for (const flavor of fs.readdirSync(dists).filter((d) => d.startsWith(`gradle-${version}-`))) {
      for (const hash of fs.readdirSync(path.join(dists, flavor))) {
        const bin = path.join(dists, flavor, hash, `gradle-${version}`, 'bin', win ? 'gradle.bat' : 'gradle');
        if (fs.existsSync(bin)) gradle = bin;
      }
    }
  }
  console.log(`\nGradle folder isn't writable, using ${env.GRADLE_USER_HOME}`);
}

run(gradle, ['assembleRelease', '--console=plain'], { cwd: android, env });

const apk = path.join(android, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(apk)) {
  console.error('Gradle finished but no APK was found at', apk);
  process.exit(1);
}
fs.mkdirSync(path.join(root, 'downloads'), { recursive: true });
const dest = path.join(root, 'downloads', 'RanchCord.apk');
fs.copyFileSync(apk, dest);
const mb = (fs.statSync(dest).size / 1024 / 1024).toFixed(1);
let signer = '';
try {
  signer = execFileSync('keytool', ['-printcert', '-jarfile', dest], { encoding: 'utf8' }).match(/Owner: (.*)/)?.[1] ?? '';
} catch {
  /* keytool not on PATH */
}
console.log(`\nAndroid app ready: downloads/RanchCord.apk (${mb} MB)${signer ? `, signed by ${signer}` : ''}`);
