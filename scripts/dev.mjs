import { spawn } from 'node:child_process';
const children = [
  spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;
function stop(code = 0) { if (stopping) return; stopping = true; for (const child of children) child.kill(); setTimeout(() => process.exit(code), 250).unref(); }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
for (const child of children) child.on('exit', code => stop(code ?? 1));
