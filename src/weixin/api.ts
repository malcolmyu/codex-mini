import { randomBytes, randomUUID } from 'node:crypto';

export const WEIXIN_QR_BASE_URL = 'https://ilinkai.weixin.qq.com/';
const PROTOCOL_VERSION = '2.4.6';
const CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
export const WEIXIN_LOGIN_POLL_TIMEOUT_MS = 5_000;

export interface WeixinCredentials {
  token: string;
  botId: string;
  ownerUserId: string;
  baseUrl: string;
}

export interface WeixinLogin {
  qrcode: string;
  qrcodeUrl: string;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isWeixinHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com')
    || host === 'wechat.com' || host.endsWith('.wechat.com');
}

export function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !isWeixinHost(url.hostname) || (url.port && url.port !== '443')) {
    throw new Error(`Untrusted Weixin URL: ${value}`);
  }
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.toString();
}

function baseInfo(): Record<string, string> {
  return { channel_version: PROTOCOL_VERSION, bot_agent: 'CodexWechatAcpPoc/0.1.0' };
}

function headers(token?: string): Record<string, string> {
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String(CLIENT_VERSION),
    'content-type': 'application/json',
    'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    ...(token ? { AuthorizationType: 'ilink_bot_token', Authorization: `Bearer ${token}` } : {}),
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  baseUrl: string,
  endpoint: string,
  options: { method: 'GET' | 'POST'; token?: string; body?: unknown; signal?: AbortSignal; timeoutMs?: number },
): Promise<Record<string, unknown>> {
  const base = normalizeBaseUrl(baseUrl);
  const url = new URL(endpoint, base);
  if (!isWeixinHost(url.hostname)) throw new Error(`Untrusted Weixin endpoint: ${url.hostname}`);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 35_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const response = await fetchImpl(url, {
    method: options.method,
    headers: headers(options.token),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal,
  });
  if (!response.ok) throw new Error(`Weixin HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Weixin JSON response');
  return value as Record<string, unknown>;
}

export class WeixinApi {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async beginLogin(signal?: AbortSignal): Promise<WeixinLogin> {
    const response = await requestJson(this.fetchImpl, WEIXIN_QR_BASE_URL, 'ilink/bot/get_bot_qrcode?bot_type=3', {
      method: 'POST',
      body: { local_token_list: [] },
      signal,
      timeoutMs: 10_000,
    });
    const qrcode = text(response.qrcode);
    const qrcodeUrl = text(response.qrcode_img_content);
    if (!qrcode || !qrcodeUrl) throw new Error('Weixin did not return a QR code');
    normalizeBaseUrl(new URL(qrcodeUrl).origin);
    return { qrcode, qrcodeUrl };
  }

  async pollLogin(qrcode: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return requestJson(
      this.fetchImpl,
      WEIXIN_QR_BASE_URL,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { method: 'GET', signal, timeoutMs: WEIXIN_LOGIN_POLL_TIMEOUT_MS },
    );
  }

  credentialsFromLogin(response: Record<string, unknown>): WeixinCredentials | null {
    if (response.status !== 'confirmed') return null;
    const token = text(response.bot_token);
    const botId = text(response.ilink_bot_id);
    const ownerUserId = text(response.ilink_user_id);
    const rawBase = text(response.baseurl) ?? WEIXIN_QR_BASE_URL;
    const baseUrl = normalizeBaseUrl(rawBase.includes('://') ? rawBase : `https://${rawBase}`);
    if (!token || !botId || !ownerUserId) throw new Error('Weixin confirmed login without complete credentials');
    return { token, botId, ownerUserId, baseUrl };
  }

  async notifyStart(credentials: WeixinCredentials, signal?: AbortSignal): Promise<void> {
    const response = await requestJson(this.fetchImpl, credentials.baseUrl, 'ilink/bot/msg/notifystart', {
      method: 'POST', token: credentials.token, body: { base_info: baseInfo() }, signal, timeoutMs: 10_000,
    });
    if (Number(response.ret ?? response.errcode ?? 0) !== 0) throw new Error(`Weixin start rejected: ${String(response.ret ?? response.errcode)}`);
  }

  async notifyStop(credentials: WeixinCredentials): Promise<void> {
    await requestJson(this.fetchImpl, credentials.baseUrl, 'ilink/bot/msg/notifystop', {
      method: 'POST', token: credentials.token, body: { base_info: baseInfo() }, timeoutMs: 10_000,
    });
  }

  async getUpdates(credentials: WeixinCredentials, cursor: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return requestJson(this.fetchImpl, credentials.baseUrl, 'ilink/bot/getupdates', {
      method: 'POST', token: credentials.token,
      body: { get_updates_buf: cursor, base_info: baseInfo() }, signal,
    });
  }

  async sendText(
    credentials: WeixinCredentials,
    toUserId: string,
    content: string,
    contextToken?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await requestJson(this.fetchImpl, credentials.baseUrl, 'ilink/bot/sendmessage', {
      method: 'POST',
      token: credentials.token,
      signal,
      body: {
        msg: {
          from_user_id: '',
          to_user_id: toUserId,
          client_id: `codex-wechat-${randomUUID()}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: content } }],
          ...(contextToken ? { context_token: contextToken } : {}),
        },
        base_info: baseInfo(),
      },
    });
    if (Number(response.ret ?? response.errcode ?? 0) !== 0) throw new Error(`Weixin send rejected: ${String(response.ret ?? response.errcode)}`);
  }
}

export function extractWeixinText(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const items = (message as { item_list?: unknown }).item_list;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as { type?: number; text_item?: { text?: unknown }; voice_item?: { text?: unknown } };
    const value = candidate.type === 1 ? candidate.text_item?.text
      : candidate.type === 3 ? candidate.voice_item?.text : undefined;
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}
