import { expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { panelFixture } from './panel-fixture';

function fixture() {
  const { webview } = panelFixture();
  const { window, document } = parseHTML(webview.html);
  const sent: Record<string, unknown>[] = [];
  vm.runInNewContext(fs.readFileSync('src/ui/webview/main.js', 'utf8'), { window, document, acquireVsCodeApi: () => ({ postMessage: (m: Record<string, unknown>) => sent.push(m) }) });
  const message = (data: Record<string, unknown>) => { const event = new window.Event('message'); Object.assign(event, { data }); window.dispatchEvent(event); };
  return { document, window, sent, message };
}

it('shows actionable setup guidance when offline or no model is configured', () => {
  const f = fixture();
  f.message({ type: 'status', payload: { trueforge: 'unreachable', running: false } });
  expect(f.document.getElementById('setupTitle')?.textContent).toBe('Connect to TrueForge');
  f.document.getElementById('setupAction')?.click();
  expect(f.sent.at(-1)).toEqual({ type: 'command', command: 'anvil.startTrueForge' });
  f.message({ type: 'status', payload: { trueforge: 'ok', running: false } });
  expect(f.document.getElementById('setupAction')?.textContent).toBe('Choose model');
});

it('preserves the draft after failed setup and clears it only when the task is accepted', () => {
  const f = fixture();
  const input = f.document.getElementById('input') as HTMLTextAreaElement;
  input.value = 'fix this';
  f.document.getElementById('send')?.click();
  expect(input.value).toBe('fix this');
  expect(f.sent.at(-1)).toEqual({ type: 'send', text: 'fix this' });
  f.message({ type: 'status', payload: { trueforge: 'unreachable', running: false } });
  expect(f.document.getElementById('send')?.hasAttribute('disabled')).toBe(false);
  f.message({ type: 'user', text: 'fix this' });
  expect(input.value).toBe('');
  expect(f.document.getElementById('welcome')).toBeNull();
});

it('renders root-thread output as the main reply and escapes model markup', () => {
  const f = fixture();
  f.message({ type: 'delta', threadId: 'random-root-id', text: '<img src=x onerror=alert(1)> answer' });
  expect(f.document.querySelector('.msg.assistant')?.textContent).toContain('<img');
  expect(f.document.querySelector('.msg.assistant img')).toBeNull();
  expect(f.document.querySelector('.card.thread')).toBeNull();
});

it('finishes pending tool indicators and restores onboarding on new chat', () => {
  const f = fixture();
  f.message({ type: 'tool.call', id: '1', name: 'propose_edit', args: '{}' });
  expect(f.document.querySelector('.card.running')).not.toBeNull();
  f.message({ type: 'turn.done', status: 'cancelled' });
  expect(f.document.querySelector('.card.running')).toBeNull();
  expect(f.document.getElementById('statusLine')?.textContent).toContain('accepted edits remain');
  f.message({ type: 'reset' });
  expect(f.document.getElementById('welcome')).not.toBeNull();
  expect(f.document.querySelector('.card')).toBeNull();
});

it('allows expanding and collapsing cards with a semantic button', () => {
  const f = fixture();
  f.message({ type: 'tool.call', id: '1', name: 'read_file', args: '{}' });
  const button = f.document.querySelector('.card > button') as HTMLButtonElement;
  expect(button.getAttribute('aria-expanded')).toBe('false');
  button.click();
  expect(button.getAttribute('aria-expanded')).toBe('true');
});


it('keeps the completed status when a cancelled command reports a late result', () => {
  const f = fixture();
  f.message({ type: 'user', text: 'run tests' });
  f.message({ type: 'turn.done', status: 'cancelled' });
  f.message({ type: 'tool.result', name: 'run_command', text: 'terminated' });
  expect(f.document.getElementById('statusLine')?.textContent).toContain('Cancelled');
});

it('keeps updating connection and session status after the welcome screen is gone', () => {
  const f = fixture();
  f.message({ type: 'user', text: 'add a command' });
  expect(f.document.getElementById('welcome')).toBeNull();
  f.message({ type: 'status', payload: { trueforge: 'ok', model: 'test/model', session: 'abcdef123456', running: true, text: 'Working' } });
  expect(f.document.getElementById('sessionChip')?.classList.contains('hidden')).toBe(false);
  expect(f.document.getElementById('sessionChip')?.textContent).toContain('abcdef12');
  expect(f.document.getElementById('tfChip')?.textContent).toBe('Connected');
});

it('labels tools that TrueForge loaded on demand, and the tool lookup itself', () => {
  const f = fixture();
  f.message({ type: 'tool.call', threadId: 'main', id: 'a', name: 'list_tools', args: '{}' });
  f.message({ type: 'tool.call', threadId: 'main', id: 'b', name: 'assemble_context', args: '{"task":"x"}', deferred: true });
  f.message({ type: 'tool.call', threadId: 'main', id: 'c', name: 'read_file', args: '{"path":"a.py"}' });
  const titles = Array.from(f.document.querySelectorAll('.card.tool .title') as ArrayLike<Element>, t => t.textContent);
  expect(titles[0]).toContain('Look up tools');
  expect(titles[0]).toContain('deferred loading');
  expect(titles[1]).toContain('Assemble context');
  expect(titles[1]).toContain('on demand');
  expect(titles[2]).not.toContain('on demand');
  expect((f.document.querySelectorAll('.card.tool .title')[1] as HTMLElement).getAttribute('title')).toBe('call_tool → assemble_context');
});
