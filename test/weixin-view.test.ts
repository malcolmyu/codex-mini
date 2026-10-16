import { describe, expect, it } from 'vitest';
import { resolveWeixinView } from '../apps/desktop/src/weixin-view.js';

describe('Weixin floating-widget state', () => {
  it('does not ask for a QR code while saved credentials are connecting', () => {
    expect(resolveWeixinView('connecting', 'idle')).toBe('connecting');
    expect(resolveWeixinView('disconnected', 'idle')).toBe('connecting');
  });

  it('does not treat a connection error as logged out', () => {
    expect(resolveWeixinView('error', 'idle')).toBe('error');
  });

  it('shows login only when login is actually required or already underway', () => {
    expect(resolveWeixinView('needs_login', 'idle')).toBe('login');
    expect(resolveWeixinView('needs_login', 'waiting_scan')).toBe('login');
    expect(resolveWeixinView('error', 'scanned')).toBe('login');
  });
});
