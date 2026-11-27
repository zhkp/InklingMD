// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod app_paths;
mod commands;
mod navigation_guard;

use commands::{
    allow_asset_dir, copy_path, create_dir, create_file, delete_path, download_remote_image,
    extract_zip, file_mtime, file_stat, find_asset_by_hash, list_dir, list_dir_files,
    list_workspace_files,
    pandoc_check, pandoc_export_docx, read_binary_file, read_document, read_recovery_file,
    read_text_file, rename_path,
    resource_themes_dir, save_document, scan_theme_dir, search_in_workspace, write_binary_file,
    write_recovery_file,
    write_text_file,
};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

/// Windows 窗口图标（即任务栏按钮图标）的像素来源（issue #432）。
///
/// Tauri 在 Windows 上把 `bundle.icon` 里第一个 `.ico` 的**目录首档**解成默认窗口图标
/// （tauri-codegen `CachedIcon::new_ico` 只取 `entries()[0]`），运行时再以
/// `WM_SETICON(ICON_SMALL)` 落到窗口上。Logo v3 的 `icon.ico` 首档是 16×16，
/// 而任务栏按钮在 100% / 125% / 150% / 200% 缩放下要画 24 / 30 / 36 / 48 px，
/// 16×16 被逐级放大后必然发糊——这就是「任务栏图标模糊」的直接成因。
///
/// Tauri 只暴露 `Window::set_icon`（落到 ICON_SMALL），没有暴露 tao 的
/// `set_taskbar_icon`（ICON_BIG），所以这里能改善的就是任务栏实际取到的那一张位图：
/// 改用同一份 Logo v3 母版直接缩放出的 256×256 预渲染档
/// （`icons/128x128@2x.png`，8bit RGBA；`@2x` 故实为 256×256），由系统按实际 DPI
/// 降采样。`icon.ico` 本身不动：它是设计包逐字节锁定的资源（#398，
/// tests/unit/brand-assets.test.ts 会校验其目录结构与整体摘要）。
const WINDOW_ICON_PNG: &[u8] = include_bytes!("../icons/128x128@2x.png");

/// 解码内置的高清窗口图标；失败时调用方回退到 codegen 的默认窗口图标
/// （Windows 上是 ICO 首档，其他平台是首个 PNG）。
fn high_resolution_window_icon() -> tauri::Result<tauri::image::Image<'static>> {
    tauri::image::Image::from_bytes(WINDOW_ICON_PNG)
}

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
    // 纯绿色模式：exe 同目录存在 portable.txt 时，「数据随身」由两部分组成——
    //   ① WebView2 用户数据目录（localStorage 等）→ exe 同级 `data/`（本块，仅 Windows 有这一层）；
    //   ② 应用数据根（themes / recovery）→ 同一个 `data/`，见 `app_paths::resolve_app_data_dir`。
    // 只做 ① 是 #404：主题与恢复区仍写系统目录，拷走便携目录就丢。
    #[cfg(target_os = "windows")]
    {
        if let Some(data_dir) = app_paths::portable_data_dir() {
            let _ = std::fs::create_dir_all(&data_dir);
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data_dir);
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

    // #432：窗口图标必须在 `run` 之前换掉——窗口管理器在构建期就把 context 里的
    // 默认图标取走了（`AppManager::with_handlers` → `WindowManager::default_icon`），
    // 之后创建的所有窗口（含前端 `WebviewWindow` 新建的派生窗口）才会拿到它。
    let mut context = tauri::generate_context!();
    match high_resolution_window_icon() {
        Ok(icon) => context.set_default_window_icon(Some(icon)),
        // 解码失败不阻止启动：退回 codegen 默认窗口图标（发糊但可用）。
        // release 是 GUI 子系统，stderr 不可见，故与既有启动错误一致落盘到临时目录日志。
        Err(e) => app_paths::record_startup_error(&format!(
            "[icon] 高清窗口图标解码失败，回退 codegen 默认窗口图标: {e}"
        )),
    }

    builder
        // #298：导航兜底——任何 webview 都不得被导航到应用自身 origin 之外
        .plugin(navigation_guard::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // 首次启动：从 argv 提取待打开的 .md 文件路径存入 state。
            // 前端就绪后调用 take_pending_file 拉取（避免事件在监听器注册前发出而丢失）。
            let args: Vec<String> = std::env::args().collect();
            let pending = md_file_from_args(&args);
            app.manage(PendingFile(Mutex::new(pending)));
            // #404：应用数据根由 app_paths 统一解析（便携 → exe 同级 data/，安装版 → app_data_dir）。
            // 迁移必须先于登记表加载：登记表是「读进来 + 后写盘」的，加载后再覆盖文件
            // 会把迁来的条目从内存视角抹掉。
            let app_dir = app_paths::resolve_app_data_dir(app.handle());
            let migration = match &app_dir {
                Ok(dir) => app_paths::prepare_portable_session(app.handle(), dir),
                Err(e) => {
                    // release 是 GUI 子系统进程，控制台看不到 → 落一份临时目录日志
                    app_paths::record_startup_error(e);
                    None
                }
            };
            if let Ok(dir) = app_dir {
                // #362：半失败登记表落在 <应用数据根>/recovery/，多窗口共用一份
                commands::init_temp_kept_registry(dir);
            }
            app.manage(app_paths::PortableMigrationState(Mutex::new(migration)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            list_dir_files,
            write_recovery_file,
            read_recovery_file,
            read_text_file,
            read_binary_file,
            write_text_file,
            write_binary_file,
            file_mtime,
            file_stat,
            read_document,
            save_document,
            pandoc_check,
            pandoc_export_docx,
            rename_path,
            delete_path,
            create_file,
            create_dir,
            search_in_workspace,
            list_workspace_files,
            allow_asset_dir,
            download_remote_image,
            find_asset_by_hash,
            scan_theme_dir,
            copy_path,
            extract_zip,
            resource_themes_dir,
            take_pending_file,
            app_paths::app_data_root,
            app_paths::take_portable_migration
        ])
        .run(context)
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

    #[test]
    fn window_icon_source_is_a_256px_bitmap() {
        let icon = high_resolution_window_icon().expect("内置窗口图标必须可解码");
        // 16×16（ICO 首档）在任务栏任何缩放比例下都要放大，必须换 256×256 档；
        // 256 也是设计包 ICO 的最大档，保证 200% 缩放（需 48px）走降采样。
        assert_eq!(
            (icon.width(), icon.height()),
            (256, 256),
            "窗口图标源必须是 256×256 档，否则任务栏会放大显示"
        );
        assert_eq!(
            icon.rgba().len() as u32,
            icon.width() * icon.height() * 4,
            "解码后的位图必须是 w*h*4 的 RGBA8 缓冲（HICON 按 4 通道读取）"
        );
    }

    #[test]
    fn window_icon_source_is_the_confirmed_rounded_brand_mark() {
        let icon = high_resolution_window_icon().expect("内置窗口图标必须可解码");
        let width = icon.width();
        let height = icon.height();
        let rgba = icon.rgba();
        let alpha_at = |x: u32, y: u32| rgba[((y * width + x) * 4 + 3) as usize];
        // 白底圆角方形：四角因圆角而透明，中心是不透明底板
        for (x, y) in [
            (0, 0),
            (width - 1, 0),
            (0, height - 1),
            (width - 1, height - 1),
        ] {
            assert_eq!(alpha_at(x, y), 0, "({x}, {y}) 应因圆角透明");
        }
        assert_eq!(alpha_at(width / 2, height / 2), 255, "中心应为不透明底板");

        let mut opaque = 0usize;
        let mut dark = 0usize;
        for chunk in rgba.chunks_exact(4) {
            if chunk[3] == 255 {
                opaque += 1;
            }
            // 品牌图形为深色线条：确认嵌入的是图形本身，而不是空白 / 纯底板
            if chunk[3] > 200 && chunk[0] < 120 && chunk[1] < 120 && chunk[2] < 160 {
                dark += 1;
            }
        }
        assert!(opaque > 50_000, "不透明底板像素过少（{opaque}），图标素材可能被替换");
        assert!(dark > 1_000, "品牌图形像素过少（{dark}），嵌入的可能不是确认母版");
    }
}
