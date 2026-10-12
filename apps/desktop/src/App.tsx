import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useMemo, useState } from 'react';

type ComponentStatus = 'disconnected' | 'connecting' | 'connected' | 'needs_login' | 'error';

interface BridgeStatus {
  protocolVersion: number;
  lifecycle: 'stopped' | 'starting' | 'running' | 'stopping' | 'needs_login' | 'error';
  weixin: ComponentStatus;
  codex: Exclude<ComponentStatus, 'needs_login'>;
  cwd: string;
  updatedAt: string;
  lastError?: string;
}

const initialStatus: BridgeStatus = {
  protocolVersion: 1,
  lifecycle: 'starting',
  weixin: 'connecting',
  codex: 'connecting',
  cwd: '正在连接 bridge…',
  updatedAt: new Date().toISOString(),
};

const labels: Record<string, string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  connected: '已连接',
  connecting: '连接中',
  disconnected: '未连接',
  needs_login: '需要登录',
  error: '异常',
};

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

export function App() {
  const [status, setStatus] = useState(initialStatus);
  const [autostart, setAutostart] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void invoke<BridgeStatus>('get_bridge_status').then(setStatus);
    void invoke<boolean>('get_autostart').then(setAutostart);
    const unlisten = listen<BridgeStatus>('bridge-status', (event) => setStatus(event.payload));
    return () => { void unlisten.then((dispose) => dispose()); };
  }, []);

  const updated = useMemo(
    () => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(status.updatedAt)),
    [status.updatedAt],
  );

  async function restart() {
    setBusy(true);
    try { setStatus(await invoke<BridgeStatus>('restart_bridge')); }
    finally { setBusy(false); }
  }

  async function toggleAutostart() {
    const next = !autostart;
    await invoke('set_autostart', { enabled: next });
    setAutostart(next);
  }

  return (
    <main>
      <header>
        <div className="mark">C</div>
        <div>
          <p className="eyebrow">CODEX WECHAT BRIDGE</p>
          <h1>连接状态</h1>
        </div>
        <span className={`pill ${status.lifecycle}`}>{labels[status.lifecycle]}</span>
      </header>

      <section className="card status-card">
        <StatusRow name="Bridge daemon" value={status.lifecycle} />
        <StatusRow name="微信 iLink" value={status.weixin} />
        <StatusRow name="Codex ACP" value={status.codex} />
      </section>

      <section className="card details">
        <div><span>工作目录</span><code>{status.cwd}</code></div>
        <div><span>IPC 协议</span><strong>v{status.protocolVersion}</strong></div>
        <div><span>最后更新</span><strong>{updated}</strong></div>
      </section>

      {status.lastError && <p className="error-box">{status.lastError}</p>}

      <section className="actions">
        <button type="button" onClick={restart} disabled={busy}>{busy ? '重启中…' : '重启 Bridge'}</button>
        <label className="toggle">
          <input type="checkbox" checked={autostart} onChange={() => void toggleAutostart()} />
          <span>登录时自动启动</span>
        </label>
      </section>

      <footer>关闭窗口后仍会在菜单栏继续运行。</footer>
    </main>
  );
}
