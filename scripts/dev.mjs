// Runs the server (restarts when you change it) and the web app with instant reload.
// Usage: npm run dev, then open http://localhost:5173
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// npm is a .cmd file on Windows, which only starts through the shell.
const start = (dir) => spawn('npm run dev', { cwd: path.join(root, dir), stdio: 'inherit', shell: true });
const children = [start('server'), start('client')];

const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) child.on('exit', (code) => code && code !== 0 && stop());
