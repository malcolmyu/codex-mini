import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import QRCode from 'qrcode';
import { useEffect, useState, type CSSProperties } from 'react';
import { formatCompactReset } from './usage-format';
import { resolveWeixinView } from './weixin-view';

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
  projectName?: string;
  gitBranch?: string;
  updatedAt: string;
  status: string;
  score: number;
  reasons: string[];
  summary?: string;
  recommendationReason?: string;
  relevanceScore?: number;
  reminderEligible?: boolean;
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
  tasks?: { candidates: PendingTask[]; scannedAt: string; analyzing?: boolean; error?: string };
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

function useBridgeStatus() {
  const [status, setStatus] = useState(initialStatus);
  useEffect(() => {
    void invoke<BridgeStatus>('get_bridge_status').then(setStatus);
    const unlisten = listen<BridgeStatus>('bridge-status', (event) => setStatus(event.payload));
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);
  return status;
}

function formatReset(value: number | null): string {
  if (!value) return '未知';
  const delta = value * 1_000 - Date.now();
  if (delta <= 0) return '即将刷新';
  const hours = Math.floor(delta / 3_600_000);
  const minutes = Math.max(1, Math.round((delta % 3_600_000) / 60_000));
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
}

function formatRelativeTime(value: string | undefined): string {
  if (!value) return '等待首次扫描';
  const deltaMinutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));
  if (deltaMinutes < 1) return '刚刚更新';
  if (deltaMinutes < 60) return `${deltaMinutes} 分钟前`;
  const hours = Math.floor(deltaMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
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

function WidgetLogin({ status, onLogin, busy }: { status: BridgeStatus; onLogin: () => void; busy: boolean }) {
  const [qrData, setQrData] = useState<string>();
  const login = status.weixinLogin;
  useEffect(() => {
    if (!login?.qrCodeUrl) { setQrData(undefined); return; }
    void QRCode.toDataURL(login.qrCodeUrl, { width: 220, margin: 1, errorCorrectionLevel: 'M' }).then(setQrData);
  }, [login?.qrCodeUrl]);

  return (
    <div className="widget-login">
      <strong>微信需要重新连接</strong>
      <span>{login?.state === 'scanned' ? '已扫码，请在微信里确认。' : '扫码后，提醒和 Codex 对话会自动恢复。'}</span>
      {qrData ? <img src={qrData} alt="微信登录二维码" /> : (
        <button type="button" onClick={onLogin} disabled={busy}>{busy ? '生成中…' : '生成登录二维码'}</button>
      )}
      {login?.state === 'expired' && <small>二维码已过期，请重新生成。</small>}
      {login?.error && <small>{login.error}</small>}
    </div>
  );
}

function WidgetConnection({
  error,
  onRetry,
  busy,
}: {
  error?: string;
  onRetry: () => void;
  busy: boolean;
}) {
  return (
    <div className="widget-connection">
      <span className="widget-connection-spinner" aria-hidden="true" />
      <strong>{error ? '微信连接暂时异常' : '正在自动连接微信'}</strong>
      <span>{error ? '已保存登录，不需要重新扫码。' : '正在使用上次保存的登录信息…'}</span>
      {error && <button type="button" onClick={onRetry} disabled={busy}>{busy ? '重试中…' : '重新连接'}</button>}
      {error && <small>{error}</small>}
    </div>
  );
}

function UsageWidget({ status }: { status: BridgeStatus }) {
  const tasks = status.tasks?.candidates ?? [];
  const taskSignature = tasks.map((task) => task.sessionId).join(':');
  const [compact, setCompact] = useState(() => localStorage.getItem('usage-widget-compact') === 'true');
  const [taskOffset, setTaskOffset] = useState(0);
  const [openingTask, setOpeningTask] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [loginBusy, setLoginBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const primary = Math.round(status.usage?.primary?.remainingPercent ?? 0);
  const secondary = Math.round(status.usage?.secondary?.remainingPercent ?? 0);
  const weixinView = resolveWeixinView(status.weixin, status.weixinLogin?.state);
  const weixinLabel = weixinView === 'connected' ? '已连接'
    : weixinView === 'login' ? '需扫码'
      : weixinView === 'connecting' ? '连接中' : '暂时异常';

  async function resizeWidget(nextCompact: boolean) {
    const window = getCurrentWindow();
    const height = nextCompact ? 80 : 440;
    await window.setSize(new LogicalSize(nextCompact ? 204 : 360, height));
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

  async function openTask(task: PendingTask) {
    setOpeningTask(task.sessionId);
    setOpenError(undefined);
    try {
      await invoke('open_codex_thread', { sessionId: task.sessionId });
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error));
    } finally {
      setOpeningTask(undefined);
    }
  }

  async function login() {
    setLoginBusy(true);
    try {
      await invoke('start_weixin_login');
    } finally {
      setLoginBusy(false);
    }
  }

  async function retryConnection() {
    setRetryBusy(true);
    try {
      await invoke('restart_bridge');
    } finally {
      setRetryBusy(false);
    }
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

  useEffect(() => {
    document.documentElement.classList.add('usage-window');
    document.body.classList.add('usage-window');
    return () => {
      document.documentElement.classList.remove('usage-window');
      document.body.classList.remove('usage-window');
    };
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('usage-compact', compact);
    document.body.classList.toggle('usage-compact', compact);
    return () => {
      document.documentElement.classList.remove('usage-compact');
      document.body.classList.remove('usage-compact');
    };
  }, [compact]);

  useEffect(() => setTaskOffset(0), [taskSignature]);

  const visibleTasks = tasks.slice(taskOffset, taskOffset + 3);

  if (compact) {
    return (
      <main className="mini-widget" data-tauri-drag-region>
        <div
          className="mini-rings"
          style={{
            '--primary-quota': `${primary * 3.6}deg`,
            '--weekly-quota': `${secondary * 3.6}deg`,
          } as CSSProperties}
          data-tauri-drag-region
          aria-label={`5 小时剩余 ${primary}%，本周剩余 ${secondary}%`}
        >
          <div className="mini-ring-inner" data-tauri-drag-region />
          <span>{primary}</span>
        </div>
        <div className="mini-copy" data-tauri-drag-region>
          <strong>{primary}<small>%</small></strong>
          <span>{formatCompactReset(status.usage?.primary?.resetsAt)}</span>
        </div>
        <button type="button" aria-label="展开用量窗口" onClick={() => toggleCompact(false)}>›</button>
      </main>
    );
  }
  return (
    <main className="widget-shell">
      <div className="widget-head" data-tauri-drag-region>
        <div data-tauri-drag-region>
          <span className="widget-mark">C</span>
          <span className="widget-heading" data-tauri-drag-region>
            <strong>Codex</strong>
            <small data-tauri-drag-region><i className={weixinView === 'connected' ? 'online' : ''} />微信{weixinLabel}</small>
          </span>
        </div>
        <div className="widget-actions">
          <button className="icon-button" type="button" aria-label="收起用量窗口" onClick={() => toggleCompact(true)}>−</button>
          <button className="icon-button quit-button" type="button" aria-label="退出应用" onClick={() => void invoke('quit_app')}>×</button>
        </div>
      </div>
      <div className="widget-usage">
        <UsageMeter title="5 小时" value={status.usage?.primary} />
        <UsageMeter title="本周" value={status.usage?.secondary} />
      </div>
      <div className="widget-section-title">
        <strong>{weixinView === 'connected' ? '推荐关注的对话' : '微信连接'}</strong>
        <div className="widget-section-meta">
          <span>{status.tasks?.analyzing ? 'Codex 分析中…' : `${formatRelativeTime(status.tasks?.scannedAt)} · ${tasks.length} 项`}</span>
          {weixinView === 'connected' && tasks.length > 3 && (
            <button
              type="button"
              onClick={() => setTaskOffset((current) => current + 3 >= tasks.length ? 0 : current + 3)}
            >换一换</button>
          )}
        </div>
      </div>
      {weixinView === 'login' ? (
        <WidgetLogin status={status} onLogin={() => void login()} busy={loginBusy} />
      ) : weixinView !== 'connected' ? (
        <WidgetConnection
          error={weixinView === 'error' ? status.lastError ?? '连接失败，请重试。' : undefined}
          onRetry={() => void retryConnection()}
          busy={retryBusy}
        />
      ) : (
        <div className="widget-task-list" aria-live="polite">
          {tasks.length === 0 ? (
            <p>{status.tasks?.error ?? (status.tasks?.analyzing ? 'Codex 正在整理最近的会话…' : '暂时没有值得继续关注的对话。')}</p>
          ) : (
            <ol>{visibleTasks.map((task) => (
              <li key={task.sessionId}>
                <button
                  type="button"
                  onClick={() => void openTask(task)}
                  disabled={openingTask === task.sessionId}
                  aria-label={`在 Codex 中打开：${task.title}`}
                  title={task.cwd}
                >
                  <span className="widget-task-copy">
                    <span className="widget-task-context">
                      <b className={task.projectName ? '' : 'standalone'}>
                        {task.projectName ? `${task.projectName}${task.gitBranch ? ` · ${task.gitBranch}` : ''}` : '独立对话'}
                      </b>
                      <time dateTime={task.updatedAt}>{formatRelativeTime(task.updatedAt)}</time>
                    </span>
                    <strong>{task.summary ?? task.title}</strong>
                    <span className="widget-task-reason">{task.recommendationReason ?? task.reasons.join(' · ')}</span>
                  </span>
                  <span className="widget-task-open" aria-hidden="true">{openingTask === task.sessionId ? '…' : '↗'}</span>
                </button>
              </li>
            ))}</ol>
          )}
        </div>
      )}
      {openError && <p className="widget-open-error">{openError}</p>}
    </main>
  );
}

export function App() {
  const status = useBridgeStatus();
  return <UsageWidget status={status} />;
}
