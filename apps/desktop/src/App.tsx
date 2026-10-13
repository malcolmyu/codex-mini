import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import QRCode from 'qrcode';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

type ComponentStatus = 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'error';

interface UsageWindow {
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

interface PendingTask {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  status: string;
  score: number;
  reasons: string[];
}

interface BridgeStatus {
  protocolVersion: number;
  lifecycle: 'stopped' | 'starting' | 'running' | 'stopping' | 'needs_login' | 'error';
  weixin: ComponentStatus;
  codex: Exclude<ComponentStatus, 'needs_login'>;
  cwd: string;
  updatedAt: string;
  usage?: {
    primary: UsageWindow | null;
    secondary: UsageWindow | null;
    planType: string | null;
    updatedAt: string;
    stale: boolean;
    error?: string;
  };
  tasks?: { candidates: PendingTask[]; scannedAt: string; error?: string };
  reminder?: { eligible: boolean; reason: string; evaluatedAt: string };
  weixinLogin?: {
    state: 'idle' | 'starting' | 'waiting_scan' | 'scanned' | 'confirmed' | 'expired' | 'error';
    qrCodeUrl?: string;
    updatedAt: string;
    error?: string;
  };
  lastError?: string;
}

const initialStatus: BridgeStatus = {
  protocolVersion: 2,
  lifecycle: 'starting',
  weixin: 'connecting',
  codex: 'connecting',
  cwd: '正在连接 bridge…',
  updatedAt: new Date().toISOString(),
};

const labels: Record<string, string> = {
  stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中',
  connected: '已连接', connecting: '连接中', disconnected: '未连接', needs_login: '需要登录', error: '异常',
};

function useBridgeStatus() {
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => {
    void invoke<BridgeStatus>('get_bridge_status').then(setStatus);
    const unlisten = listen<BridgeStatus>('bridge-status', (event) => setStatus(event.payload));
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);
  return [status, setStatus] as const;
}

function formatReset(value: number | null): string {
  if (!value) return '未知';
  const delta = value * 1_000 - Date.now();
  if (delta <= 0) return '即将刷新';
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.max(1, Math.round((delta % 3_600_000) / 60_000));
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function UsageMeter({ title, value }: { title: string; value: UsageWindow | null | undefined }) {
  const remaining = Math.round(value?.remainingPercent ?? 0);
  return (
    <div className="usage-meter">
      <div className="usage-label"><span>{title}</span><strong>{value ? `${remaining}%` : '—'}</strong></div>
      <div className="usage-track"><span style={{ width: `${remaining}%` }} /></div>
      <small>{value ? `${formatReset(value.resetsAt)}后重置` : '等待 Codex 用量数据'}</small>
    </div>
  );
}

function StatusRow({ name, value }: { name: string; value: string }) {
  const healthy = value === 'running' || value === 'connected';
  return (
    <div className="status-row">
      <span className={`dot ${healthy ? 'healthy' : value}`} />
      <span className="status-name">{name}</span>
      <strong>{labels[value] ?? value}</strong>
    </div>
  );
}

function LoginPanel({ status, onLogin, busy }: { status: BridgeStatus; onLogin: () => void; busy: boolean }) {
  const [qrData, setQrData] = useState<string>();
  const login = status.weixinLogin;
  useEffect(() => {
    if (!login?.qrCodeUrl) { setQrData(undefined); return; }
    void QRCode.toDataURL(login.qrCodeUrl, { width: 220, margin: 1, errorCorrectionLevel: 'M' }).then(setQrData);
  }, [login?.qrCodeUrl]);

  if (status.weixin === 'connected' && login?.state !== 'starting') {
    return <button className="text-button" type="button" onClick={onLogin}>重新登录微信</button>;
  }
  return (
    <section className="card login-card">
      <div>
        <p className="section-kicker">WEIXIN LOGIN</p>
        <h2>微信扫码连接</h2>
        <p>{login?.state === 'scanned' ? '已扫码，请在微信里确认。' : 'Bridge 断开后，可以在这里重新生成二维码。'}</p>
      </div>
      {qrData ? <img className="qr-code" src={qrData} alt="微信登录二维码" /> : (
        <button type="button" onClick={onLogin} disabled={busy}>{busy ? '生成中…' : '生成登录二维码'}</button>
      )}
      {login?.state === 'expired' && <p className="inline-error">二维码已过期，请重新生成。</p>}
      {login?.error && <p className="inline-error">{login.error}</p>}
    </section>
  );
}

function UsageWidget({ status }: { status: BridgeStatus }) {
  const tasks = status.tasks?.candidates ?? [];
  const [compact, setCompact] = useState(() => localStorage.getItem('usage-widget-compact') === 'true');
  const primary = Math.round(status.usage?.primary?.remainingPercent ?? 0);
  const secondary = Math.round(status.usage?.secondary?.remainingPercent ?? 0);

  async function resizeWidget(nextCompact: boolean) {
    const window = getCurrentWindow();
    await window.setSize(new LogicalSize(nextCompact ? 204 : 360, nextCompact ? 80 : 320));
    const [position, size, monitor] = await Promise.all([
      window.outerPosition(),
      window.outerSize(),
      currentMonitor(),
    ]);
    if (!monitor) return;
    const minX = monitor.position.x;
    const minY = monitor.position.y;
    const maxX = minX + monitor.size.width - size.width;
    const maxY = minY + monitor.size.height - size.height;
    const x = Math.min(Math.max(position.x, minX), Math.max(minX, maxX));
    const y = Math.min(Math.max(position.y, minY), Math.max(minY, maxY));
    if (x !== position.x || y !== position.y) await window.setPosition(new PhysicalPosition(x, y));
  }

  function toggleCompact(nextCompact: boolean) {
    setCompact(nextCompact);
    localStorage.setItem('usage-widget-compact', String(nextCompact));
    void resizeWidget(nextCompact);
  }

  useEffect(() => {
    const window = getCurrentWindow();
    const saved = localStorage.getItem('usage-widget-position');
    if (saved) {
      try {
        const position = JSON.parse(saved) as { x: number; y: number };
        void window.setPosition(new PhysicalPosition(position.x, position.y));
      } catch { localStorage.removeItem('usage-widget-position'); }
    }
    void resizeWidget(compact);
    const unlisten = window.onMoved(({ payload }) => localStorage.setItem(
      'usage-widget-position',
      JSON.stringify({ x: payload.x, y: payload.y }),
    ));
    return () => { void unlisten.then((dispose) => dispose()); };
    // The initial compact value is intentionally applied once; later changes go through toggleCompact.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (compact) {
    return (
      <main className="mini-widget" data-tauri-drag-region>
        <div className="mini-ring" style={{ '--quota': `${primary * 3.6}deg` } as CSSProperties} data-tauri-drag-region>
          <span>{primary}</span>
        </div>
        <div className="mini-copy" data-tauri-drag-region>
          <strong>{primary}<small>%</small></strong>
          <span>周 {secondary}% · {tasks.length} 项</span>
        </div>
        <button type="button" aria-label="展开用量窗口" onClick={() => toggleCompact(false)}>›</button>
      </main>
    );
  }
  return (
    <main className="widget-shell">
      <div className="widget-head" data-tauri-drag-region>
        <div data-tauri-drag-region><span className="widget-mark">C</span><strong>Codex 剩余用量</strong></div>
        <div className="widget-actions">
          <button className="icon-button" type="button" aria-label="收起用量窗口" onClick={() => toggleCompact(true)}>−</button>
          <button className="icon-button" type="button" aria-label="隐藏悬浮窗" onClick={() => void getCurrentWindow().hide()}>×</button>
        </div>
      </div>
      <div className="widget-usage">
        <UsageMeter title="5 小时" value={status.usage?.primary} />
        <UsageMeter title="本周" value={status.usage?.secondary} />
      </div>
      <div className="widget-tasks">
        <div><span>待继续</span><strong>{tasks.length} 项</strong></div>
        <p>{tasks[0]?.title ?? status.reminder?.reason ?? '正在扫描本地任务…'}</p>
      </div>
      <button className="widget-refresh" type="button" onClick={() => void invoke('refresh_insights')}>立即检查</button>
    </main>
  );
}

function MainWindow({ status, setStatus }: { status: BridgeStatus; setStatus: (status: BridgeStatus) => void }) {
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void invoke<boolean>('get_autostart').then(setAutostart); }, []);
  const updated = useMemo(
    () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(status.updatedAt)),
    [status.updatedAt],
  );

  async function restart() {
    setBusy(true);
    try { setStatus(await invoke<BridgeStatus>('restart_bridge')); } finally { setBusy(false); }
  }
  async function refresh() {
    setBusy(true);
    try { await invoke('refresh_insights'); } finally { setBusy(false); }
  }
  async function login() {
    setBusy(true);
    try { await invoke('start_weixin_login'); } finally { setBusy(false); }
  }
  async function toggleAutostart() {
    const next = !autostart;
    await invoke('set_autostart', { enabled: next });
    setAutostart(next);
  }

  const tasks = status.tasks?.candidates ?? [];
  return (
    <main className="main-shell">
      <header>
        <div className="mark">C</div>
        <div><p className="eyebrow">CODEX WECHAT BRIDGE</p><h1>连接与用量</h1></div>
        <span className={`pill ${status.lifecycle}`}>{labels[status.lifecycle]}</span>
      </header>

      <section className="card usage-card">
        <UsageMeter title="5 小时窗口剩余" value={status.usage?.primary} />
        <UsageMeter title="周窗口剩余" value={status.usage?.secondary} />
        <button className="small-button" type="button" onClick={() => void refresh()} disabled={busy}>立即检查</button>
      </section>

      <section className="card status-card">
        <StatusRow name="Bridge daemon" value={status.lifecycle} />
        <StatusRow name="微信 iLink" value={status.weixin} />
        <StatusRow name="Codex ACP" value={status.codex} />
      </section>

      <LoginPanel status={status} onLogin={() => void login()} busy={busy} />

      <section className="card task-card">
        <div className="section-title">
          <div><p className="section-kicker">PENDING TASKS</p><h2>值得继续的任务</h2></div>
          <span>{tasks.length}</span>
        </div>
        {tasks.length === 0 ? <p className="empty">{status.tasks?.error ?? '没有检测到需要继续的问题。'}</p> : (
          <ol>{tasks.slice(0, 5).map((task) => (
            <li key={task.sessionId}>
              <strong>{task.title}</strong>
              <span>{task.reasons.join(' · ')}</span>
              <code>{task.cwd}</code>
            </li>
          ))}</ol>
        )}
        <p className={`decision ${status.reminder?.eligible ? 'ready' : ''}`}>{status.reminder?.reason ?? '正在判断是否需要提醒…'}</p>
      </section>

      <section className="card details">
        <div><span>工作目录</span><code>{status.cwd}</code></div>
        <div><span>IPC 协议</span><strong>v{status.protocolVersion}</strong></div>
        <div><span>最后更新</span><strong>{updated}</strong></div>
      </section>
      {(status.lastError || status.usage?.error) && <p className="error-box">{status.lastError ?? status.usage?.error}</p>}
      <section className="actions">
        <button type="button" onClick={() => void restart()} disabled={busy}>{busy ? '处理中…' : '重启 Bridge'}</button>
        <label className="toggle"><input type="checkbox" checked={autostart} onChange={() => void toggleAutostart()} /><span>登录时自动启动</span></label>
      </section>
      <footer>悬浮窗和 Bridge 在关闭设置窗口后仍会继续运行。</footer>
    </main>
  );
}

export function App() {
  const [status, setStatus] = useBridgeStatus();
  return getCurrentWindow().label === 'usage'
    ? <UsageWidget status={status} />
    : <MainWindow status={status} setStatus={setStatus} />;
}
