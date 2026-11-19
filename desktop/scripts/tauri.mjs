// Runs the Tauri CLI with a couple of conveniences:
// - If your normal Cargo folder (~/.cargo) can't be written to, Rust downloads go to desktop/.cargo-home instead.
// - If ../secrets/tauri-updater.key exists, release builds are signed for auto-updates with it.
// Usage: node scripts/tauri.mjs dev | build | icon app-icon.png -o src-tauri/icons
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };

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

if (!env.CARGO_HOME) {
  const defaultHome = path.join(os.homedir(), '.cargo');
  if (!writable(path.join(defaultHome, 'registry'))) {
    env.CARGO_HOME = path.join(desktop, '.cargo-home');
    console.log(`Cargo folder isn't writable, using ${env.CARGO_HOME}`);
  }
}

const key = path.resolve(desktop, '..', 'secrets', 'tauri-updater.key');
if (!env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(key)) {
  env.TAURI_SIGNING_PRIVATE_KEY = key;
  env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= '';
}

const cli = path.join(desktop, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { cwd: desktop, env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
