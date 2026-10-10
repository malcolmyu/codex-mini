import { describe, expect, it } from 'vitest';
import { splitText, visibleError } from '../src/core/text.js';

describe('splitText', () => {
  it('keeps short text intact and prefers a nearby boundary', () => {
    expect(splitText('hello')).toEqual(['hello']);
    expect(splitText('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
  });

  it('does not emit empty chunks', () => {
    expect(splitText('   ')).toEqual([]);
    expect(splitText('abcdefghij', 3)).toEqual(['abc', 'def', 'ghi', 'j']);
  });
});

describe('visibleError', () => {
  it('explains the active writer conflict', () => {
    expect(visibleError({ data: { reason: 'thread_active_writer' } })).toContain('Codex 桌面端');
  });
});
