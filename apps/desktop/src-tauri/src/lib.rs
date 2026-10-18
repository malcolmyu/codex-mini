mod supervisor;

use std::sync::{Arc, Mutex};
use supervisor::{BridgeStatus, SupervisorHandle};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    Manager, State, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};

struct AppState {
    status: Arc<Mutex<BridgeStatus>>,
    supervisor: SupervisorHandle,
}

#[tauri::command]
fn get_bridge_status(state: State<'_, AppState>) -> BridgeStatus {
    state.status.lock().expect("status lock poisoned").clone()
}

#[tauri::command]
fn restart_bridge(state: State<'_, AppState>) -> Result<BridgeStatus, String> {
    state.supervisor.restart()?;
    let mut status = state.status.lock().expect("status lock poisoned");
    status.lifecycle = "starting".into();
    status.weixin = "connecting".into();
    status.codex = "connecting".into();
    status.last_error = None;
    Ok(status.clone())
}

#[tauri::command]
fn refresh_insights(state: State<'_, AppState>) -> Result<(), String> {
    state.supervisor.refresh_insights()
}

#[tauri::command]
fn start_weixin_login(state: State<'_, AppState>) -> Result<(), String> {
    state.supervisor.start_weixin_login()
}

fn valid_thread_id(value: &str) -> bool {
    value.len() >= 32
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[tauri::command]
fn open_codex_thread(session_id: String) -> Result<(), String> {
    if !valid_thread_id(&session_id) {
        return Err("无效的 Codex 会话 ID".into());
    }
    let url = format!("codex://threads/{session_id}");
    let status = std::process::Command::new("/usr/bin/open")
        .args(["-b", "com.openai.codex", &url])
        .status()
        .map_err(|error| format!("无法唤起 Codex: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Codex 无法打开该会话（退出状态 {status}）"))
    }
}

#[tauri::command]
fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn set_autostart(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn show_usage_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("usage") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn install_status_item(app: &tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show-widget", "显示浮层", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh-usage", "立即刷新额度", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit-app", "退出 Codex Mini", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &refresh, &separator, &quit])?;
    let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

    TrayIconBuilder::with_id("codex-mini-status")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Codex Mini")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show-widget" => show_usage_window(app),
            "refresh-usage" => {
                let _ = app.state::<AppState>().supervisor.refresh_insights();
                show_usage_window(app);
            }
            "quit-app" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_usage_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            get_bridge_status,
            restart_bridge,
            refresh_insights,
            start_weixin_login,
            open_codex_thread,
            get_autostart,
            set_autostart,
            quit_app,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)?;
            let status = Arc::new(Mutex::new(BridgeStatus::default()));
            let supervisor = SupervisorHandle::spawn(app.handle().clone(), status.clone());
            app.manage(AppState { status, supervisor });
            install_status_item(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Codex WeChat desktop app");

    app.run(|handle, event| match event {
        tauri::RunEvent::Reopen { .. } => show_usage_window(handle),
        tauri::RunEvent::Exit => {
            handle.state::<AppState>().supervisor.shutdown();
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::valid_thread_id;

    #[test]
    fn validates_codex_thread_ids() {
        assert!(valid_thread_id("01a1261f-f32d-7e60-a4d6-655612da6386"));
        assert!(!valid_thread_id("../not-a-thread"));
        assert!(!valid_thread_id("too-short"));
    }
}
