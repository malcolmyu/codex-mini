export type WeixinComponentStatus = 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'error';
export type WeixinLoginState = 'idle' | 'starting' | 'waiting_scan' | 'scanned' | 'confirmed' | 'expired' | 'error';
export type WeixinView = 'connected' | 'connecting' | 'login' | 'error';

export function resolveWeixinView(
  status: WeixinComponentStatus,
  loginState: WeixinLoginState | undefined,
): WeixinView {
  if (status === 'connected') return 'connected';
  if (status === 'needs_login' || ['starting', 'waiting_scan', 'scanned', 'expired'].includes(loginState ?? '')) {
    return 'login';
  }
  if (status === 'connecting' || status === 'disconnected') return 'connecting';
  return 'error';
}

