import { describe, it, expect } from 'vitest';
import { applyEditBlocks, locateBlock, EditBlockError } from '../src/edit/editBlocks';

const FILE = `def get_debug_flag() -> bool:\n    """Get whether debug mode should be enabled."""\n    val = os.environ.get("FLASK_DEBUG")\n    return bool(val and val.lower() not in {"0", "false", "no"})\n\n\ndef other():\n    return 1\n`;

describe('edit blocks', () => {
  it('applies an exact block', () => {
    const r = applyEditBlocks(FILE, [{ old: '    return bool(val and val.lower() not in {"0", "false", "no"})', new: '    return bool(val and val.lower() not in {"0", "false", "no", "off", "n"})' }]);
    expect(r.content).toContain('"off", "n"');
    expect(r.notes).toEqual([]);
  });

  it('matches with trailing whitespace differences', () => {
    const r = applyEditBlocks(FILE, [{ old: 'def other():   \n    return 1', new: 'def other():\n    return 2' }]);
    expect(r.content).toContain('return 2');
    expect(r.notes[0]).toContain('trailing-whitespace');
  });

  it('matches ignoring indentation and re-indents the replacement', () => {
    const r = applyEditBlocks(FILE, [{ old: 'return 1', new: 'return 42' }]);
    expect(r.content).toContain('    return 42');
  });

  it('rejects ambiguous blocks', () => {
    const f = 'x = 1\ny = 2\nx = 1\n';
    expect(() => applyEditBlocks(f, [{ old: 'x = 1', new: 'x = 3' }])).toThrow(EditBlockError);
    expect(() => applyEditBlocks(f, [{ old: 'x = 1', new: 'x = 3' }])).toThrow(/2 times/);
  });

  it('rejects missing blocks with a helpful message', () => {
    expect(() => applyEditBlocks(FILE, [{ old: 'does not exist', new: 'x' }])).toThrow(/not found/);
  });

  it('locateBlock reports the strategy', () => {
    const r = locateBlock(FILE, 'def other():\n    return 1');
    expect('strategy' in r && r.strategy).toBe('exact');
  });

  it('applies several blocks in order', () => {
    const r = applyEditBlocks(FILE, [
      { old: '"""Get whether debug mode should be enabled."""', new: '"""Get whether debug mode should be enabled.\n\n    False values: 0, false, no, off, n."""' },
      { old: 'def other():\n    return 1', new: 'def other():\n    return 3' },
    ]);
    expect(r.content).toContain('False values');
    expect(r.content).toContain('return 3');
  });
});
