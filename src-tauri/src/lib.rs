// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod commands;

use commands::{
    allow_asset_dir, create_dir, create_file, delete_path, file_mtime, list_dir, pandoc_check,
    pandoc_export_docx, read_text_file, rename_path, search_in_workspace, write_binary_file,
    write_text_file,
};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// 待打开文件：首次启动时从 argv 提取，前端就绪后通过 take_pending_file 拉取。
/// 用 Mutex<Option> 让命令能 take 走值，避免重复打开。
struct PendingFile(Mutex<Option<String>>);

#[tauri::command]
fn take_pending_file(state: tauri::State<PendingFile>) -> Option<String> {
    take_pending_file_value(&state.0)
}

fn take_pending_file_value(pending: &Mutex<Option<String>>) -> Option<String> {
    pending.lock().ok().and_then(|mut value| value.take())
}

/// 从启动参数中提取首个 Markdown 文件路径（文件关联双击打开场景）。
/// 跳过选项参数（以 `-` 开头）；程序自身路径因不以 .md 结尾会被后缀过滤排除。
fn md_file_from_args(args: &[String]) -> Option<String> {
    args.iter()
        .filter(|a| !a.starts_with('-'))
        .find(|a| {
            let l = a.to_lowercase();
            l.ends_with(".md") || l.ends_with(".markdown")
        })
        .cloned()
}

/// 选择 open-file 事件的目标窗口 label（issue #147）。
///
/// 旧实现硬编码 `emit_to("main", ...)`：用户可关闭主窗口而保留派生窗口
/// （应用不退出），此后文件关联双击的转发无接收者、静默失败。这里改为
/// 「主窗口存活优先，否则退回任一存活窗口」，并把选择确定化（按 label
/// 字典序取第一个），避免 HashMap 迭代序不稳定导致窗口选择漂移。
///
/// 返回 None 表示没有任何存活窗口（调用方记日志后忽略即可）。
fn pick_open_file_target_label<'a, I: IntoIterator<Item = &'a str>>(labels: I) -> Option<String> {
    let mut alive: Vec<&str> = labels.into_iter().collect();
    if alive.contains(&"main") {
        return Some("main".to_string());
    }
    alive.sort_unstable();
    alive.first().map(|label| (*label).to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 纯绿色模式：当 exe 同目录存在 portable.txt 标记文件时，
    // 将 WebView2 用户数据目录重定向到 exe 同目录下的 data 文件夹，
    // 实现免安装、数据随身、不污染系统目录。
    #[cfg(target_os = "windows")]
    {
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                if parent.join("portable.txt").exists() {
                    let data_dir = parent.join("data");
                    let _ = std::fs::create_dir_all(&data_dir);
                    std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir);
                }
            }
        }
    }

    let mut builder = tauri::Builder::default();

    // 单实例：程序已运行时，双击 .md 文件启动的第二个进程会把 argv 转发到主实例，
    // 由存活窗口监听 open-file 事件打开文件，避免开出多个实例。
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = md_file_from_args(argv.get(1..).unwrap_or_default()) {
                // 定向到主窗口，避免派生窗口重复打开
                let windows = app.webview_windows();
                let target = pick_open_file_target_label(windows.keys().map(String::as_str));
                match target {
                    // 目标窗口（main 或存活派生窗口）：发送并前置。
                    // 旧实现吞掉发送失败——main 已关闭时用户双击 .md 静默无反馈。
                    Some(label) => {
                        if let Err(e) = app.emit_to(&label, "open-file", &path) {
                            eprintln!("[open-file] 转发到窗口 {label} 失败: {e}");
                        }
                        if let Some(win) = windows.get(&label) {
                            // 最小化时双击也应恢复并前置（issue #147）
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                    None => eprintln!("[open-file] 无存活窗口，忽略 {path}"),
                }
            }
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 首次启动：从 argv 提取待打开的 .md 文件路径存入 state。
            // 前端就绪后调用 take_pending_file 拉取（避免事件在监听器注册前发出而丢失）。
            let args: Vec<String> = std::env::args().collect();
            let pending = md_file_from_args(&args);
            app.manage(PendingFile(Mutex::new(pending)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_text_file,
            write_text_file,
            write_binary_file,
            file_mtime,
            pandoc_check,
            pandoc_export_docx,
            rename_path,
            delete_path,
            create_file,
            create_dir,
            search_in_workspace,
            allow_asset_dir,
            take_pending_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn markdown_argument_detection_is_case_insensitive_and_skips_options() {
        let cases = [
            (args(&["inkling", "--portable", "/docs/note.md"]), Some("/docs/note.md")),
            (args(&["inkling", "-v", "C:/Docs/NOTE.MARKDOWN"]), Some("C:/Docs/NOTE.MARKDOWN")),
            (args(&["inkling", "readme.txt", "/docs/second.md"]), Some("/docs/second.md")),
            (args(&["inkling", "--file=/docs/hidden.md"]), None),
            (Vec::new(), None),
        ];

        for (input, expected) in cases {
            assert_eq!(md_file_from_args(&input).as_deref(), expected);
        }
    }

    #[test]
    fn pending_file_is_taken_only_once() {
        let pending = Mutex::new(Some("/docs/once.md".to_string()));
        assert_eq!(take_pending_file_value(&pending).as_deref(), Some("/docs/once.md"));
        assert_eq!(take_pending_file_value(&pending), None);
    }

    #[test]
    fn empty_forwarded_argv_has_a_safe_tail() {
        let argv: Vec<String> = Vec::new();
        assert_eq!(md_file_from_args(argv.get(1..).unwrap_or_default()), None);
    }

    #[test]
    fn open_file_target_prefers_main_window_when_alive() {
        // 主窗口存活（含同时有派生窗口）→ 仍定向 main（旧行为，避免派生窗口重复打开）
        let cases: [(&[&str], Option<&str>); 2] = [
            (&["main", "inkling-1", "inkling-2"], Some("main")),
            (&["main"], Some("main")),
        ];
        for (labels, expected) in cases {
            assert_eq!(pick_open_file_target_label(labels.iter().copied()).as_deref(), expected);
        }
    }

    #[test]
    fn open_file_target_falls_back_to_surviving_derived_window() {
        // 主窗口已关闭（应用仍因派生窗口存活）：issue #147 修复点——不再静默丢失
        assert_eq!(
            pick_open_file_target_label(["inkling-9", "inkling-1"].iter().copied()).as_deref(),
            Some("inkling-1"),
            "主窗口关闭后应退回应答存活的派生窗口，且选择确定化"
        );
        assert_eq!(
            pick_open_file_target_label(["child-b", "child-a"].iter().copied()).as_deref(),
            Some("child-a"),
            "字典序决定多个派生窗口中的目标，避免 HashMap 迭代序漂移"
        );
    }

    #[test]
    fn open_file_target_none_when_no_windows_alive() {
        let labels: [&str; 0] = [];
        assert_eq!(pick_open_file_target_label(labels.iter().copied()), None);
    }
}
