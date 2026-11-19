import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, watch as watchFiles } from 'node:fs';

const watch = process.argv.includes('--watch');

/** @type {esbuild.BuildOptions} */
const extensionOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  // The MCP SDK and TrueForge SDK are ESM; esbuild bundles them into CJS fine.
  mainFields: ['module', 'main'],
  define: { 'process.env.NODE_ENV': '"production"' },
};

/** Headless host: the same MCP server + retriever running against a plain folder (for CI / e2e without VS Code). */
const headlessOptions = {
  entryPoints: ['src/host/headlessMain.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/headless.js',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
  mainFields: ['module', 'main'],
};

const editorTestsOptions = { ...headlessOptions, entryPoints: ['src/host/editorTests.ts'], outfile: 'dist/editorTests.js' };

const e2eOptions = { ...headlessOptions, entryPoints: ['src/host/e2eMain.ts'], outfile: 'dist/e2e.js' };
const liveOptions = { ...headlessOptions, entryPoints: ['src/host/liveVerification.ts'], outfile: 'dist/liveVerification.js' };

mkdirSync('dist/webview', { recursive: true });
cpSync('src/ui/webview', 'dist/webview', { recursive: true });

if (watch) {
  const ctx = await esbuild.context(extensionOptions);
  const ctx2 = await esbuild.context(headlessOptions);
  const ctx3 = await esbuild.context(e2eOptions);
  const ctx4 = await esbuild.context(editorTestsOptions);
  const ctx5 = await esbuild.context(liveOptions);
  watchFiles('src/ui/webview', { recursive: true }, () => cpSync('src/ui/webview', 'dist/webview', { recursive: true }));
  await Promise.all([ctx.watch(), ctx2.watch(), ctx3.watch(), ctx4.watch(), ctx5.watch()]);
  console.log('watching…');
} else {
  await esbuild.build(extensionOptions);
  await esbuild.build(headlessOptions);
  await esbuild.build(e2eOptions);
  await esbuild.build(editorTestsOptions);
  await esbuild.build(liveOptions);
}
