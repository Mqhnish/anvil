import { expect, it } from 'vitest';
import { commands } from './vscode-mock';
import { panelFixture } from './panel-fixture';

it('queues early events until the webview handshake, then delivers them in order', async () => {
  const f = panelFixture();
  f.panel.post({ type: 'user', text: 'hello' });
  expect(f.webview.postMessage).not.toHaveBeenCalled();
  await f.receive({ type: 'ready' });
  expect(f.webview.postMessage.mock.calls[0][0]).toEqual({ type: 'user', text: 'hello' });
  expect(f.webview.postMessage.mock.calls[1][0].type).toBe('status');
});

it('refreshes running controls even when a send fails during preflight', async () => {
  const f = panelFixture();
  await f.receive({ type: 'ready' });
  await f.receive({ type: 'send', text: 'change' });
  expect(f.delegate.send).toHaveBeenCalledWith('change');
  expect(f.webview.postMessage.mock.lastCall?.[0]).toMatchObject({ type: 'status', payload: { running: false } });
});

it('does not execute arbitrary commands posted by a webview', async () => {
  const f = panelFixture();
  commands.executeCommand.mockClear();
  await f.receive({ type: 'command', command: 'workbench.action.terminal.new' });
  expect(commands.executeCommand).not.toHaveBeenCalled();
  await f.receive({ type: 'command', command: 'anvil.startTrueForge' });
  expect(commands.executeCommand).toHaveBeenCalledWith('anvil.startTrueForge');
});

it('denies pending command approvals when the panel is disposed', async () => {
  const f = panelFixture();
  const approval = f.panel.requestCommandApproval('npm test');
  f.dispose();
  expect((await approval).allow).toBe(false);
});
