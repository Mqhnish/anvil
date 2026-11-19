import { vi } from 'vitest';
export const files = new Map<string, string>();
export class Uri {
  scheme = 'file'; query = '';
  constructor(readonly fsPath: string) {}
  static file(p: string) { return new Uri(p); }
  static parse(p: string) { const uri = new Uri(p); uri.scheme = p.split(':')[0]; uri.query = p.split('?')[1] ?? ''; return uri; }
  toString() { return this.fsPath; }
}
export const ProgressLocation = { Notification: 15 };
export class Position { constructor(public line: number, public character: number) {} }
export class Range { constructor(..._args: unknown[]) {} }
export class ThemeColor { constructor(readonly value: string) {} }
export class EventEmitter<T> { event = vi.fn(); fire(_value?: T) {} dispose() {} }
export class WorkspaceEdit {
  operations: { type: string; path: string; text?: string }[] = [];
  createFile(uri: Uri) { this.operations.push({ type: 'create', path: uri.fsPath }); }
  deleteFile(uri: Uri) { this.operations.push({ type: 'delete', path: uri.fsPath }); }
  insert(uri: Uri, _pos: Position, text: string) { this.operations.push({ type: 'write', path: uri.fsPath, text }); }
  replace(uri: Uri, _range: Range, text: string) { this.operations.push({ type: 'write', path: uri.fsPath, text }); }
}
export const ViewColumn = { Active: -1 };
export const FileType = { File: 1, Directory: 2 };
const disposable = () => ({ dispose() {} });
export const workspace = {
  textDocuments: [],
  registerTextDocumentContentProvider: vi.fn(disposable),
  onDidCloseTextDocument: vi.fn(disposable),
  fs: { readFile: vi.fn(async (uri: Uri) => Buffer.from(files.get(uri.fsPath) ?? '')), stat: vi.fn(async (uri: Uri) => { if (!files.has(uri.fsPath)) throw new Error('missing'); return { type: FileType.File }; }) },
  openTextDocument: vi.fn(async (uri: Uri) => ({ getText: () => files.get(uri.fsPath) ?? '', positionAt: (offset: number) => new Position(0, offset), isDirty: false, save: vi.fn(async () => true) })),
  applyEdit: vi.fn(async (edit: WorkspaceEdit) => {
    for (const op of edit.operations) {
      if (op.type === 'delete') files.delete(op.path);
      else files.set(op.path, op.type === 'create' ? '' : op.text!);
    }
    return true;
  }),
};
export const window = {
  activeTextEditor: undefined as unknown,
  showInputBox: vi.fn(async () => 'test instruction'),
  withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<void>) => task({ report() {} }, { onCancellationRequested() { return { dispose() {} }; } })),
  setStatusBarMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  createTextEditorDecorationType: vi.fn(disposable),
  onDidChangeVisibleTextEditors: vi.fn(disposable),
  visibleTextEditors: [],
  tabGroups: { all: [], close: vi.fn() },
  showWarningMessage: vi.fn(async () => 'Restore'),
  showErrorMessage: vi.fn(),
};
export const languages = { registerCodeLensProvider: vi.fn(disposable) };
export const commands = { registerCommand: vi.fn(disposable), executeCommand: vi.fn(async () => {}) };
