import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CommandResult } from './types';

/**
 * The environment for an agent command. If the workspace root has a Python virtual environment (`.venv` or `venv`),
 * its bin directory goes first on PATH, the way an activated terminal would have it, so `pytest` or `python` run
 * the project's own interpreter instead of whatever VS Code was launched with.
 */
export function commandEnv(root: string | undefined, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: 'dumb', NO_COLOR: '1' };
  if (!root) return env;
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const venv = ['.venv', 'venv'].map(d => path.join(root, d)).find(d => fs.existsSync(path.join(d, bin)));
  if (!venv) return env;
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = path.join(venv, bin) + path.delimiter + (env[key] ?? '');
  env.VIRTUAL_ENV = venv;
  return env;
}

/** Bound output, handle spawn failures, and stop the shell's process group on cancellation. */
export function executeCommand(command: string, cwd: string, opts: { timeoutMs?: number; signal?: AbortSignal; root?: string } = {}): Promise<CommandResult> {
  const started = Date.now();
  if (opts.signal?.aborted) return Promise.resolve({ exitCode: null, stdout: '', stderr: 'Command cancelled before starting.', timedOut: false, durationMs: 0 });
  return new Promise(resolve => {
    const child = spawn(command, { shell: true, cwd, detached: process.platform !== 'win32', env: commandEnv(opts.root) });
    let stdout = '', stderr = '', timedOut = false, cancelled = false;
    const kill = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        // Windows has no process groups: kill the shell's whole tree, or e.g. pytest keeps running after cmd.exe dies.
        else if (process.platform === 'win32' && child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        else child.kill('SIGKILL');
      } catch { /* already exited */ }
    };
    const cancel = () => { cancelled = true; kill(); };
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs ?? 120000);
    const cleanup = () => { clearTimeout(timer); opts.signal?.removeEventListener('abort', cancel); };
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-200000); });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-100000); });
    opts.signal?.addEventListener('abort', cancel, { once: true });
    if (opts.signal?.aborted) cancel();
    child.on('error', e => { cleanup(); resolve({ exitCode: null, stdout, stderr: stderr + '\n' + e.message, timedOut, durationMs: Date.now() - started }); });
    // A cancelled command has no meaningful exit code on any platform (taskkill makes it 1 on Windows).
    child.on('close', code => { cleanup(); resolve({ exitCode: cancelled ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - started }); });
  });
}
