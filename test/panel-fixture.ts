import { vi } from 'vitest';
import type * as vscode from 'vscode';
import { AgentPanel, type PanelDelegate } from '../src/ui/panel';
import { Uri, commands } from './vscode-mock';

export function panelFixture() {
  let receive!: (message: Record<string, unknown>) => Promise<void>;
  let dispose!: () => void;
  const webview = { options: {}, html: '', cspSource: 'test:', asWebviewUri: (u: { toString(): string }) => u.toString(), postMessage: vi.fn(), onDidReceiveMessage: (fn: typeof receive) => { receive = fn; } };
  const view = { webview, onDidDispose: (fn: () => void) => { dispose = fn; }, show: vi.fn() };
  const delegate: PanelDelegate = { send: vi.fn(async () => {}), cancel: vi.fn(async () => {}), newChat: () => true, openSession: vi.fn(), selectModel: vi.fn(), index: () => undefined, status: () => ({ trueforge: 'ok', model: 'test/model', running: false }) };
  const panel = new AgentPanel({ extensionUri: Uri.file(process.cwd()) } as unknown as vscode.ExtensionContext, delegate);
  panel.resolveWebviewView(view as unknown as vscode.WebviewView);
  return { panel, webview, delegate, receive: (m: Record<string, unknown>) => receive(m), dispose: () => dispose() };
}

