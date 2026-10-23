import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition, LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
import QRCode from 'qrcode';
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { formatCompactReset, formatOrbReset, isQuotaUrgent } from './usage-format';
import { resolveWeixinView } from './weixin-view';
import {
  collapsedWidgetBounds,
  COMPACT_WIDGET_SIZE,
  expandedWidgetBounds,
  exceedsDragThreshold,
  EXPANDED_WIDGET_MIN_HEIGHT,
  fitExpandedWidgetHeight,
  orbDragOrigin,
  orbOriginFromWindow,
  ORB_CHROME_INSET,
  ORB_COLLAPSE_DELAY_MS,
  type OrbExpandDirection,
  WIDGET_MOTION_DURATION_MS,
} from './widget-motion';

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

function formatReset(value: number | null, nowMs = Date.now()): string {
  if (!value) return '未知';
  const delta = value * 1_000 - nowMs;
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

function UsageMeter({
  title,
  value,
  urgent,
  nowMs,
}: {
  title: string;
  value: UsageWindow | null | undefined;
  urgent: boolean;
  nowMs: number;
}) {
  const remaining = Math.round(value?.remainingPercent ?? 0);
  return (
    <div className={`usage-meter${urgent ? ' urgent' : ''}`}>
      <div className="usage-label"><span>{title}</span><strong>{value ? `${remaining}%` : '—'}</strong></div>
      <div className="usage-track"><span style={{ width: `${remaining}%` }} /></div>
      <small>{value
        ? urgent
          ? `即将恢复，建议用掉 · ${formatReset(value.resetsAt, nowMs)}`
          : `${formatReset(value.resetsAt, nowMs)}后重置`
        : '等待 Codex 用量数据'}</small>
    </div>
  );
}

function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 44 44" aria-hidden="true">
      <path d="M33.3 10.7A16 16 0 1 0 33.3 33.3" className="brand-ring-outer" />
      <path d="M28.4 15.6A9 9 0 1 0 28.4 28.4" className="brand-ring-inner" />
      <path d="M32.5 17.2Q32.5 16.2 33.4 16.8L40.8 21.1Q42.4 22 40.8 22.9L33.4 27.2Q32.5 27.8 32.5 26.8V17.2Z" className="brand-bridge" />
    </svg>
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
  const [compact, setCompact] = useState(true);
  const compactRef = useRef(true);
  const [pinned, setPinned] = useState(false);
  const pinnedRef = useRef(false);
  const [draggingOrb, setDraggingOrb] = useState(false);
  const draggingOrbRef = useRef(false);
  const [direction, setDirection] = useState<OrbExpandDirection>({ horizontal: 'left', vertical: 'up' });
  const directionRef = useRef<OrbExpandDirection>(direction);
  const panelHeightRef = useRef(EXPANDED_WIDGET_MIN_HEIGHT);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerInside = useRef(false);
  const orbGesture = useRef<{
    pointerId: number;
    grabX: number;
    grabY: number;
    startX: number;
    startY: number;
    dragging: boolean;
    collapsing: boolean;
    lastOrigin?: { x: number; y: number };
  } | undefined>(undefined);
  const [taskOffset, setTaskOffset] = useState(0);
  const [openingTask, setOpeningTask] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [loginBusy, setLoginBusy] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const [motion, setMotion] = useState<'idle' | 'collapsing' | 'expanding'>('idle');
  const [nowMs, setNowMs] = useState(Date.now);
  const motionRunning = useRef(false);
  const expandedContent = useRef<HTMLDivElement>(null);
  const primary = Math.round(status.usage?.primary?.remainingPercent ?? 0);
  const secondary = Math.round(status.usage?.secondary?.remainingPercent ?? 0);
  const primaryUrgent = isQuotaUrgent(status.usage?.primary, nowMs);
  const secondaryUrgent = isQuotaUrgent(status.usage?.secondary, nowMs);
  const quotaUrgent = primaryUrgent || secondaryUrgent;
  const urgencyLabel = [
    primaryUrgent ? '5 小时额度即将恢复，建议用掉' : '',
    secondaryUrgent ? '本周额度即将恢复，建议用掉' : '',
  ].filter(Boolean).join('；');
  const weixinView = resolveWeixinView(status.weixin, status.weixinLogin?.state);
  const weixinLabel = weixinView === 'connected' ? '已连接'
    : weixinView === 'login' ? '需扫码'
      : weixinView === 'connecting' ? '连接中' : '暂时异常';

  function clearCollapseTimer() {
    if (collapseTimer.current === undefined) return;
    clearTimeout(collapseTimer.current);
    collapseTimer.current = undefined;
  }

  function applyPinned(next: boolean) {
    pinnedRef.current = next;
    setPinned(next);
  }

  async function windowGeometry() {
    const appWindow = getCurrentWindow();
    const [position, monitor] = await Promise.all([appWindow.outerPosition(), currentMonitor()]);
    if (!monitor) return undefined;
    const scale = monitor.scaleFactor;
    return {
      appWindow,
      position: { x: position.x / scale, y: position.y / scale },
      workArea: {
        x: monitor.position.x / scale,
        y: monitor.position.y / scale,
        width: monitor.size.width / scale,
        height: monitor.size.height / scale,
      },
    };
  }

  async function applyLogicalBounds(bounds: { x: number; y: number; width: number; height: number }) {
    const appWindow = getCurrentWindow();
    await appWindow.setPosition(new LogicalPosition(bounds.x, bounds.y));
    await appWindow.setSize(new LogicalSize(bounds.width, bounds.height));
  }

  async function expandOrb(pin = false) {
    clearCollapseTimer();
    if (!compactRef.current || motionRunning.current) {
      if (pin) applyPinned(true);
      return;
    }
    motionRunning.current = true;
    if (pin) applyPinned(true);
    try {
      const geometry = await windowGeometry();
      if (!geometry) return;
      const orb = {
        x: geometry.position.x + ORB_CHROME_INSET,
        y: geometry.position.y + ORB_CHROME_INSET,
      };
      const bounds = expandedWidgetBounds(
        orb,
        geometry.workArea,
        { width: 360, height: panelHeightRef.current },
      );
      const nextDirection = { horizontal: bounds.horizontal, vertical: bounds.vertical } as const;
      directionRef.current = nextDirection;
      setDirection(nextDirection);
      await applyLogicalBounds(bounds);
      compactRef.current = false;
      setMotion('expanding');
      setCompact(false);
      void invoke('refresh_insights');
      await new Promise((resolve) => setTimeout(resolve, WIDGET_MOTION_DURATION_MS));
    } finally {
      setMotion('idle');
      motionRunning.current = false;
      if (!pointerInside.current && !pin) scheduleCollapse();
    }
  }

  async function collapseOrb(force = false) {
    clearCollapseTimer();
    if (compactRef.current || (!force && (motionRunning.current || pinnedRef.current))) return;
    motionRunning.current = true;
    if (force) applyPinned(false);
    try {
      if (!force) {
        setMotion('collapsing');
        await new Promise((resolve) => setTimeout(resolve, WIDGET_MOTION_DURATION_MS));
      }
      const geometry = await windowGeometry();
      if (!geometry) return;
      const orb = orbOriginFromWindow(
        {
          ...geometry.position,
          width: globalThis.innerWidth,
          height: globalThis.innerHeight,
        },
        directionRef.current,
      );
      compactRef.current = true;
      setCompact(true);
      await applyLogicalBounds(collapsedWidgetBounds(orb));
    } finally {
      setMotion('idle');
      motionRunning.current = false;
    }
  }

  function scheduleCollapse() {
    clearCollapseTimer();
    if (compactRef.current || pinnedRef.current || draggingOrbRef.current) return;
    collapseTimer.current = setTimeout(() => {
      collapseTimer.current = undefined;
      void collapseOrb();
    }, ORB_COLLAPSE_DELAY_MS);
  }

  async function resizeExpandedPanel(height: number) {
    if (compactRef.current || motionRunning.current) return;
    const geometry = await windowGeometry();
    if (!geometry) return;
    const orb = orbOriginFromWindow(
      {
        ...geometry.position,
        width: globalThis.innerWidth,
        height: globalThis.innerHeight,
      },
      directionRef.current,
    );
    const bounds = expandedWidgetBounds(orb, geometry.workArea, { width: 360, height });
    panelHeightRef.current = height;
    const nextDirection = { horizontal: bounds.horizontal, vertical: bounds.vertical } as const;
    directionRef.current = nextDirection;
    setDirection(nextDirection);
    await applyLogicalBounds(bounds);
  }

  function beginOrbGesture(event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    orbGesture.current = {
      pointerId: event.pointerId,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      startX: event.screenX,
      startY: event.screenY,
      dragging: false,
      collapsing: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCollapsedOrb(origin: { x: number; y: number }) {
    return getCurrentWindow().setPosition(new LogicalPosition(
      origin.x - ORB_CHROME_INSET,
      origin.y - ORB_CHROME_INSET,
    ));
  }

  function moveOrbGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = orbGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const origin = orbDragOrigin(
      { x: gesture.grabX, y: gesture.grabY },
      { x: event.screenX, y: event.screenY },
    );
    gesture.lastOrigin = origin;
    if (!gesture.dragging) {
      if (!exceedsDragThreshold(
        { x: gesture.startX, y: gesture.startY },
        { x: event.screenX, y: event.screenY },
      )) return;
      gesture.dragging = true;
      draggingOrbRef.current = true;
      setDraggingOrb(true);
      applyPinned(false);
      if (!compactRef.current) {
        gesture.collapsing = true;
        void collapseOrb(true).then(() => {
          const current = orbGesture.current;
          if (!current || !current.dragging) return;
          current.collapsing = false;
          if (current.lastOrigin) void moveCollapsedOrb(current.lastOrigin);
        });
        return;
      }
    }
    if (!gesture.collapsing) void moveCollapsedOrb(origin);
  }

  function finishOrbGesture(event: ReactPointerEvent<HTMLElement>, activateClick = true) {
    const gesture = orbGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    orbGesture.current = undefined;
    draggingOrbRef.current = false;
    setDraggingOrb(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (gesture.dragging) {
      if (gesture.lastOrigin) void moveCollapsedOrb(gesture.lastOrigin);
      return;
    }
    if (!activateClick) return;
    if (compactRef.current) void expandOrb(true);
    else applyPinned(!pinnedRef.current);
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
    void window.setSize(new LogicalSize(COMPACT_WIDGET_SIZE, COMPACT_WIDGET_SIZE));
    const unlisten = window.onMoved(({ payload }) => {
      if (!compactRef.current) return;
      localStorage.setItem('usage-widget-position', JSON.stringify({ x: payload.x, y: payload.y }));
    });
    return () => {
      clearCollapseTimer();
      void unlisten.then((dispose) => dispose());
    };
    // Startup always follows dsh-orb's collapsed cold state.
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

  useEffect(() => {
    const enter = () => {
      pointerInside.current = true;
      clearCollapseTimer();
      if (compactRef.current) void expandOrb();
    };
    const leave = () => {
      pointerInside.current = false;
      scheduleCollapse();
    };
    document.body.addEventListener('pointerenter', enter);
    document.body.addEventListener('pointerleave', leave);
    return () => {
      document.body.removeEventListener('pointerenter', enter);
      document.body.removeEventListener('pointerleave', leave);
    };
  });

  useEffect(() => {
    if (compact || !expandedContent.current) return undefined;
    const content = expandedContent.current;
    let frame = 0;
    let cancelled = false;
    const fitContent = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        void (async () => {
          const monitor = await currentMonitor();
          if (cancelled || !monitor) return;
          const contentHeight = Math.ceil(content.getBoundingClientRect().height + 28);
          const availableHeight = Math.floor(monitor.size.height / monitor.scaleFactor) - ORB_CHROME_INSET * 2;
          const targetHeight = fitExpandedWidgetHeight(contentHeight, availableHeight);
          if (Math.abs(globalThis.innerHeight - ORB_CHROME_INSET * 2 - targetHeight) < 1) return;
          await resizeExpandedPanel(targetHeight);
        })();
      });
    };
    const observer = new ResizeObserver(fitContent);
    observer.observe(content);
    fitContent();
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
    // Window geometry is independent from status rendering; recreate only when compact state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);

  useEffect(() => setTaskOffset(0), [taskSignature]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const visibleTasks = tasks.slice(taskOffset, taskOffset + 3);

  return (
    <main
      className={`orb-stage ${compact ? 'compact' : 'expanded'} ${pinned ? 'pinned' : ''} ${draggingOrb ? 'dragging' : ''} ${quotaUrgent ? 'quota-urgent' : ''} ${primaryUrgent ? 'primary-urgent' : ''} ${secondaryUrgent ? 'secondary-urgent' : ''} expand-${direction.horizontal} expand-${direction.vertical} widget-motion-${motion}`}
    >
      <section className="widget-shell">
      <div className="widget-content" ref={expandedContent}>
      <div className="widget-head">
        <div>
          <span className="widget-heading">
            <strong>Codex</strong>
            <small><i className={weixinView === 'connected' ? 'online' : ''} />微信{weixinLabel}</small>
          </span>
        </div>
        <div className="widget-actions">
          <button className="icon-button" type="button" aria-label="收起用量窗口" onClick={() => void collapseOrb(true)}>−</button>
          <button className="icon-button quit-button" type="button" aria-label="退出应用" onClick={() => void invoke('quit_app')}>×</button>
        </div>
      </div>
      <div className="widget-usage">
        <UsageMeter title="5 小时" value={status.usage?.primary} urgent={primaryUrgent} nowMs={nowMs} />
        <UsageMeter title="本周" value={status.usage?.secondary} urgent={secondaryUrgent} nowMs={nowMs} />
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
      </div>
      </section>
      <button
        className="usage-orb"
        style={{
          '--primary-quota': `${primary * 3.6}deg`,
          '--weekly-quota': `${secondary * 3.6}deg`,
        } as CSSProperties}
        type="button"
        title={formatCompactReset(status.usage?.primary?.resetsAt, nowMs)}
        aria-label={`5 小时剩余 ${primary}%，${formatCompactReset(status.usage?.primary?.resetsAt, nowMs)}；本周剩余 ${secondary}%${urgencyLabel ? `；${urgencyLabel}` : ''}；点击固定或取消固定`}
        onPointerDown={beginOrbGesture}
        onPointerMove={moveOrbGesture}
        onPointerUp={finishOrbGesture}
        onPointerCancel={(event) => finishOrbGesture(event, false)}
        onLostPointerCapture={(event) => finishOrbGesture(event, false)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (compactRef.current) void expandOrb(true);
          else applyPinned(!pinnedRef.current);
        }}
      >
        <span className="mini-orb-button" aria-hidden="true">
          <span className="mini-orb-value"><strong>{primary}</strong><span>%</span></span>
          <small className="mini-orb-reset">{formatOrbReset(status.usage?.primary?.resetsAt, nowMs)}</small>
        </span>
      </button>
    </main>
  );
}

export function App() {
  const status = useBridgeStatus();
  return <UsageWidget status={status} />;
}
