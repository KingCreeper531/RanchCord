// Downloads the newest app installers from the GitHub release into downloads/, so friends can get
// them straight from your server ("Download the apps" in RanchCord).
// Private repo? Put a GitHub token with read access in GITHUB_TOKEN.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const WANTED = ['RanchCord-Setup.exe', 'RanchCord.apk', 'RanchCord.ipa'];

function repoFromGit() {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8' }).trim();
    return /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

const repo = process.env.RANCHCORD_REPO || repoFromGit();
if (!repo) {
  console.log('Not a GitHub checkout; skipping app downloads');
  process.exit(0);
}
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ranchcord-server' };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
if (res.status === 404) {
  console.log('No GitHub release yet');
  process.exit(0);
}
if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
const release = await res.json();

const dir = path.join(root, 'downloads');
fs.mkdirSync(dir, { recursive: true });
for (const asset of release.assets ?? []) {
  if (!WANTED.includes(asset.name)) continue;
  const dest = path.join(dir, asset.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size === asset.size) continue;
  const file = await fetch(asset.url, { headers: { ...headers, Accept: 'application/octet-stream' } });
  if (!file.ok) throw new Error(`Couldn't download ${asset.name} (${file.status})`);
  fs.writeFileSync(`${dest}.part`, Buffer.from(await file.arrayBuffer()));
  fs.renameSync(`${dest}.part`, dest);
  console.log(`Downloaded ${asset.name} from ${release.tag_name}`);
}
