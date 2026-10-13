mod supervisor;

use std::sync::{Arc, Mutex};
use supervisor::{BridgeStatus, SupervisorHandle};
use tauri::{
    menu::{Menu, MenuItem},
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

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_usage_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("usage") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
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
            get_autostart,
            set_autostart,
        ])
        .setup(|app| {
            let status = Arc::new(Mutex::new(BridgeStatus::default()));
            let supervisor = SupervisorHandle::spawn(app.handle().clone(), status.clone());
            app.manage(AppState { status, supervisor });

            let open = MenuItem::with_id(app, "open", "打开状态", true, None::<&str>)?;
            let usage = MenuItem::with_id(app, "usage", "显示用量悬浮窗", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "立即检查", true, None::<&str>)?;
            let login = MenuItem::with_id(app, "login", "重新登录微信", true, None::<&str>)?;
            let restart = MenuItem::with_id(app, "restart", "重启 Bridge", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &usage, &refresh, &login, &restart, &quit])?;
            TrayIconBuilder::new()
                .title("Codex")
                .tooltip("Codex 微信桥")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "usage" => show_usage_window(app),
                    "refresh" => {
                        let _ = app.state::<AppState>().supervisor.refresh_insights();
                    }
                    "login" => {
                        show_main_window(app);
                        let _ = app.state::<AppState>().supervisor.start_weixin_login();
                    }
                    "restart" => {
                        let _ = app.state::<AppState>().supervisor.restart();
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
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

    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            handle.state::<AppState>().supervisor.shutdown();
        }
    });
}
