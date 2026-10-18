use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver, SyncSender, TryRecvError},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Emitter;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub protocol_version: u8,
    pub lifecycle: String,
    pub weixin: String,
    pub codex: String,
    pub cwd: String,
    pub updated_at: String,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub tasks: Option<Value>,
    #[serde(default)]
    pub reminder: Option<Value>,
    #[serde(default)]
    pub weixin_login: Option<Value>,
    #[serde(default)]
    pub last_error: Option<String>,
}

impl Default for BridgeStatus {
    fn default() -> Self {
        Self {
            protocol_version: 2,
            lifecycle: "starting".into(),
            weixin: "connecting".into(),
            codex: "connecting".into(),
            cwd: project_root().display().to_string(),
            updated_at: "1970-01-01T00:00:00.000Z".into(),
            usage: None,
            tasks: None,
            reminder: None,
            weixin_login: None,
            last_error: None,
        }
    }
}

enum SupervisorCommand {
    Restart,
    RefreshInsights,
    StartWeixinLogin,
    Shutdown,
}

#[derive(Clone)]
pub struct SupervisorHandle {
    commands: SyncSender<SupervisorCommand>,
    worker: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl SupervisorHandle {
    pub fn spawn(app: tauri::AppHandle, status: Arc<Mutex<BridgeStatus>>) -> Self {
        let (commands, receiver) = mpsc::sync_channel(8);
        let worker = thread::Builder::new()
            .name("bridge-supervisor".into())
            .spawn(move || supervisor_loop(app, status, receiver))
            .expect("failed to spawn bridge supervisor");
        Self {
            commands,
            worker: Arc::new(Mutex::new(Some(worker))),
        }
    }

    pub fn restart(&self) -> Result<(), String> {
        self.commands
            .send(SupervisorCommand::Restart)
            .map_err(|_| "Bridge supervisor is not running".to_string())
    }

    pub fn shutdown(&self) {
        let _ = self.commands.send(SupervisorCommand::Shutdown);
        if let Some(worker) = self
            .worker
            .lock()
            .expect("supervisor worker lock poisoned")
            .take()
        {
            let _ = worker.join();
        }
    }

    pub fn refresh_insights(&self) -> Result<(), String> {
        self.commands
            .send(SupervisorCommand::RefreshInsights)
            .map_err(|_| "Bridge supervisor is not running".to_string())
    }

    pub fn start_weixin_login(&self) -> Result<(), String> {
        self.commands
            .send(SupervisorCommand::StartWeixinLogin)
            .map_err(|_| "Bridge supervisor is not running".to_string())
    }
}

enum DaemonOutput {
    Line(String),
    Closed,
}

fn supervisor_loop(
    app: tauri::AppHandle,
    status: Arc<Mutex<BridgeStatus>>,
    commands: Receiver<SupervisorCommand>,
) {
    let mut restart_attempt = 0usize;
    let mut requested_restart = true;
    let mut shutting_down = false;

    while !shutting_down {
        if !requested_restart {
            match commands.recv() {
                Ok(SupervisorCommand::Restart) => requested_restart = true,
                Ok(SupervisorCommand::RefreshInsights)
                | Ok(SupervisorCommand::StartWeixinLogin) => requested_restart = true,
                Ok(SupervisorCommand::Shutdown) | Err(_) => break,
            }
        }
        if !requested_restart {
            continue;
        }
        requested_restart = false;

        let (mut child, mut stdin, output) = match spawn_daemon() {
            Ok(value) => value,
            Err(error) => {
                publish_error(&app, &status, error);
                match restart_delay(restart_attempt) {
                    Some(delay) => {
                        restart_attempt += 1;
                        if wait_for_command(&commands, delay, &mut shutting_down) {
                            requested_restart = true;
                            restart_attempt = 0;
                        } else if !shutting_down {
                            requested_restart = true;
                        }
                        continue;
                    }
                    None => break,
                }
            }
        };

        set_starting(&app, &status);
        let _ = send_request(&mut stdin, "desktop-start", "bridge.start");
        let started = Instant::now();

        loop {
            match commands.try_recv() {
                Ok(SupervisorCommand::Restart) => {
                    stop_child(&mut child, &mut stdin);
                    requested_restart = true;
                    restart_attempt = 0;
                    break;
                }
                Ok(SupervisorCommand::RefreshInsights) => {
                    let _ = send_request(&mut stdin, "desktop-refresh", "insights.refresh");
                }
                Ok(SupervisorCommand::StartWeixinLogin) => {
                    let _ = send_request(&mut stdin, "desktop-weixin-login", "weixin.login.start");
                }
                Ok(SupervisorCommand::Shutdown) | Err(TryRecvError::Disconnected) => {
                    shutting_down = true;
                    stop_child(&mut child, &mut stdin);
                    break;
                }
                Err(TryRecvError::Empty) => {}
            }

            loop {
                match output.try_recv() {
                    Ok(DaemonOutput::Line(line)) => {
                        if let Some(next) = parse_daemon_status(&line) {
                            publish(&app, &status, next);
                        }
                    }
                    Ok(DaemonOutput::Closed) | Err(TryRecvError::Disconnected) => break,
                    Err(TryRecvError::Empty) => break,
                }
            }

            match child.try_wait() {
                Ok(Some(exit)) => {
                    publish_error(&app, &status, format!("Bridge daemon exited: {exit}"));
                    break;
                }
                Ok(None) => {}
                Err(error) => {
                    publish_error(
                        &app,
                        &status,
                        format!("Failed to inspect bridge daemon: {error}"),
                    );
                    break;
                }
            }
            thread::sleep(Duration::from_millis(60));
        }

        if shutting_down {
            break;
        }
        if requested_restart {
            continue;
        }
        if started.elapsed() > Duration::from_secs(600) {
            restart_attempt = 0;
        }
        match restart_delay(restart_attempt) {
            Some(delay) => {
                restart_attempt += 1;
                if wait_for_command(&commands, delay, &mut shutting_down) {
                    restart_attempt = 0;
                }
                requested_restart = !shutting_down;
            }
            None => break,
        }
    }
}

fn spawn_daemon() -> Result<(Child, ChildStdin, Receiver<DaemonOutput>), String> {
    let root = project_root();
    let daemon = root.join("dist/src/daemon.js");
    if !daemon.exists() {
        return Err(format!("Bridge daemon is not built: {}", daemon.display()));
    }
    let node = node_command(&root);
    let mut command = Command::new(&node);
    command
        .arg(&daemon)
        .current_dir(&root)
        .env("CODEX_WECHAT_HOME", &root)
        .env("NODE_NO_WARNINGS", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(node_bin) = node.parent() {
        let inherited_path = env::var_os("PATH").unwrap_or_default();
        let paths =
            std::iter::once(node_bin.to_path_buf()).chain(env::split_paths(&inherited_path));
        if let Ok(path) = env::join_paths(paths) {
            command.env("PATH", path);
        }
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start {}: {error}", node.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or("Bridge daemon stdin unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Bridge daemon stdout unavailable")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("Bridge daemon stderr unavailable")?;
    let (sender, receiver) = mpsc::channel();
    let output_sender = sender.clone();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if output_sender.send(DaemonOutput::Line(line)).is_err() {
                return;
            }
        }
        let _ = output_sender.send(DaemonOutput::Closed);
    });
    thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            eprintln!("[bridge] {line}");
        }
    });
    Ok((child, stdin, receiver))
}

fn node_command(root: &std::path::Path) -> PathBuf {
    resolve_node_command(
        root,
        env::var_os("CODEX_WECHAT_NODE").map(PathBuf::from),
        env::var_os("HOME").map(PathBuf::from),
        env::var_os("NVM_BIN").map(PathBuf::from),
    )
}

fn resolve_node_command(
    root: &std::path::Path,
    configured: Option<PathBuf>,
    home: Option<PathBuf>,
    nvm_bin: Option<PathBuf>,
) -> PathBuf {
    if let Some(configured) = configured {
        return configured;
    }
    if let (Some(home), Ok(version)) = (home, std::fs::read_to_string(root.join(".nvmrc"))) {
        let version = version.trim();
        let version_dir = if version.starts_with('v') {
            version.to_string()
        } else {
            format!("v{version}")
        };
        let node = home
            .join(".nvm/versions/node")
            .join(version_dir)
            .join("bin/node");
        if node.exists() {
            return node;
        }
    }
    if let Some(nvm_bin) = nvm_bin {
        let node = nvm_bin.join("node");
        if node.exists() {
            return node;
        }
    }
    PathBuf::from("node")
}

fn send_request(stdin: &mut ChildStdin, id: &str, request_type: &str) -> Result<(), String> {
    let line = json!({ "v": 2, "id": id, "type": request_type });
    writeln!(stdin, "{line}").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
}

fn stop_child(child: &mut Child, stdin: &mut ChildStdin) {
    let _ = send_request(stdin, "desktop-shutdown", "shutdown");
    for _ in 0..20 {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn wait_for_command(
    commands: &Receiver<SupervisorCommand>,
    delay: Duration,
    shutting_down: &mut bool,
) -> bool {
    match commands.recv_timeout(delay) {
        Ok(SupervisorCommand::Restart)
        | Ok(SupervisorCommand::RefreshInsights)
        | Ok(SupervisorCommand::StartWeixinLogin) => true,
        Ok(SupervisorCommand::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => {
            *shutting_down = true;
            false
        }
        Err(mpsc::RecvTimeoutError::Timeout) => false,
    }
}

fn parse_daemon_status(line: &str) -> Option<BridgeStatus> {
    let value: Value = serde_json::from_str(line).ok()?;
    if value.get("event")?.as_str()? == "status.changed" {
        return serde_json::from_value(value.get("data")?.clone()).ok();
    }
    if value.get("ok")?.as_bool()? && value.get("id")?.as_str()? == "desktop-start" {
        return serde_json::from_value(value.get("result")?.clone()).ok();
    }
    None
}

fn publish(app: &tauri::AppHandle, state: &Arc<Mutex<BridgeStatus>>, next: BridgeStatus) {
    *state.lock().expect("status lock poisoned") = next.clone();
    let _ = app.emit("bridge-status", next);
}

fn set_starting(app: &tauri::AppHandle, state: &Arc<Mutex<BridgeStatus>>) {
    let mut next = state.lock().expect("status lock poisoned").clone();
    next.lifecycle = "starting".into();
    next.weixin = "connecting".into();
    next.codex = "connecting".into();
    next.last_error = None;
    publish(app, state, next);
}

fn publish_error(
    app: &tauri::AppHandle,
    state: &Arc<Mutex<BridgeStatus>>,
    message: impl Into<String>,
) {
    let mut next = state.lock().expect("status lock poisoned").clone();
    next.lifecycle = "error".into();
    next.weixin = "error".into();
    next.codex = "error".into();
    next.last_error = Some(message.into());
    publish(app, state, next);
}

fn project_root() -> PathBuf {
    env::var_os("CODEX_WECHAT_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.."))
}

fn restart_delay(attempt: usize) -> Option<Duration> {
    [1, 2, 5, 30, 30]
        .get(attempt)
        .map(|seconds| Duration::from_secs(*seconds))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn extracts_status_event() {
        let line = r#"{"v":2,"event":"status.changed","data":{"protocolVersion":2,"lifecycle":"running","weixin":"connected","codex":"connected","cwd":"/project","updatedAt":"2026-10-12T00:00:00.000Z"}}"#;
        let status = parse_daemon_status(line).expect("status event");
        assert_eq!(status.lifecycle, "running");
        assert_eq!(status.cwd, "/project");
    }

    #[test]
    fn restart_policy_is_bounded() {
        assert_eq!(restart_delay(0), Some(Duration::from_secs(1)));
        assert_eq!(restart_delay(3), Some(Duration::from_secs(30)));
        assert_eq!(restart_delay(5), None);
    }

    #[test]
    fn project_nvmrc_takes_priority_over_the_active_nvm_version() {
        let base = env::temp_dir().join(format!(
            "codex-wechat-node-resolution-{}",
            std::process::id()
        ));
        let root = base.join("project");
        let home = base.join("home");
        let pinned_node = home.join(".nvm/versions/node/v22.23.2/bin/node");
        let active_nvm = base.join("active-nvm");
        fs::create_dir_all(pinned_node.parent().expect("pinned node parent"))
            .expect("create pinned node directory");
        fs::create_dir_all(&active_nvm).expect("create active nvm directory");
        fs::create_dir_all(&root).expect("create project directory");
        fs::write(root.join(".nvmrc"), "22.23.2\n").expect("write nvmrc");
        fs::write(&pinned_node, "").expect("create pinned node");
        fs::write(active_nvm.join("node"), "").expect("create active node");

        let resolved = resolve_node_command(&root, None, Some(home), Some(active_nvm));

        assert_eq!(resolved, pinned_node);
        fs::remove_dir_all(base).expect("remove node resolution fixture");
    }
}
