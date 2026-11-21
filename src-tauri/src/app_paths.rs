//! 应用数据根目录解析（#404）。
//!
//! 便携模式（exe 同级存在 `portable.txt`）对用户的承诺是「免安装、数据随身、不污染
//! 系统目录」。在 #404 之前它只把 WebView2 的用户数据目录指到 exe 同级 `data/`，
//! Tauri 的 `app_data_dir()`（`%APPDATA%\<identifier>`）完全没动：themes/ 与 recovery/
//! 仍写进系统目录，把便携目录拷到另一台机器就丢。
//!
//! 为什么不能靠环境变量统一修：`WEBVIEW2_USER_DATA_FOLDER` 只影响 WebView2 的浏览器
//! 缓存目录；`app_data_dir()` 由 identifier 经系统 API 解析（Windows 走
//! `SHGetKnownFolderPath`，**不读** `%APPDATA%` 环境变量），Tauri v2 也没有提供覆盖
//! 入口。所以应用数据根必须由本模块统一解析——Rust 侧（恢复区写入、半失败登记表）
//! 与前端（themes / recovery 路径）都向它取值；两边一旦不同源，
//! `write_recovery_file` 的路径守卫会把前端算出来的路径判成「恢复区之外」。
//!
//! 安装版（没有标记文件）仍走 `app_data_dir()` 原路径：升级不得让用户已有主题「消失」。

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

/// 便携模式标记文件名（必须与 exe 同目录）
pub const PORTABLE_MARKER: &str = "portable.txt";
/// 便携数据的目录名（exe 同级）
pub const PORTABLE_DATA_DIR: &str = "data";
/// 需要随包搬走的数据子目录（旧位置 → 便携位置）
pub const MIGRATED_SUBDIRS: [&str; 2] = ["themes", "recovery"];

/// 便携模式首次启动时从旧位置复制过来的结果。
///
/// 三个清单都为空 = 没有可报告的事（全新机器首启、或已经迁移过），前端不弹提示。
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct PortableMigration {
    /// 旧数据根（安装版使用的 `app_data_dir()`）
    pub from: String,
    /// 便携数据根（exe 同级 `data/`）
    pub to: String,
    /// 成功复制过来的子目录名
    pub copied: Vec<String>,
    /// 复制失败的子目录（含原因）——必须让用户看见，不能当成「没这回事」
    pub failed: Vec<String>,
    /// 复制过程中跳过的条目（符号链接等，含原因）
    pub skipped: Vec<String>,
}

impl PortableMigration {
    /// 是否有需要告知用户的内容
    pub fn has_report(&self) -> bool {
        !self.copied.is_empty() || !self.failed.is_empty() || !self.skipped.is_empty()
    }
}

/// 便携数据根（尚未创建）。纯函数：路径与「标记文件是否存在」都显式传入，便于单测。
pub fn portable_data_dir_from_exe(exe: &Path, marker_exists: bool) -> Option<PathBuf> {
    if !marker_exists {
        return None;
    }
    exe.parent().map(|parent| parent.join(PORTABLE_DATA_DIR))
}

/// 当前进程的便携数据根（`None` = 非便携模式）
pub fn portable_data_dir() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let marker_exists = exe.parent()?.join(PORTABLE_MARKER).exists();
    portable_data_dir_from_exe(&exe, marker_exists)
}

/// 应用数据根：便携模式 → exe 同级 `data/`（顺带建好目录）；安装版 → `app_data_dir()`。
///
/// 返回值同时是 recovery 路径守卫的根，以及前端 themes / recovery 的根。
pub fn resolve_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(dir) = portable_data_dir() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建便携数据目录失败 {}: {e}", dir.display()))?;
        return Ok(dir);
    }
    app.path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))
}

/// 便携模式启动准备：放行 asset scope + 从旧位置迁移数据。
///
/// 返回 `None` 表示非便携模式（安装版路径完全不变），或没有需要告知用户的迁移内容。
///
/// asset scope 是这条改动的硬前置：`tauri.conf.json` 的静态 scope 只有 `$APPDATA/**`
/// 与 `$APPLOCALDATA/**`，覆盖不到 exe 同级目录；主题 CSS 里的 `url()` 资源经
/// `convertFileSrc` 走 asset 协议，不放行就会被判越界、字体/图片静默降级。
/// 放行机制与工作区图片相同（`allow_asset_dir` → `asset_protocol_scope().allow_directory`），
/// 只是这里在窗口创建前对应用数据根放行一次。
pub fn prepare_portable_session(app: &tauri::AppHandle, data_dir: &Path) -> Option<PortableMigration> {
    if portable_data_dir().is_none() {
        return None;
    }
    // 目录必须已存在：`allow_directory` 会对模式做 canonicalize
    if let Err(e) = app.asset_protocol_scope().allow_directory(data_dir, true) {
        // 失败不阻断启动（主题文件本身可读），但必须留痕：否则用户只会看到
        // 「主题里的图片/字体不显示」而查不到原因
        eprintln!(
            "[portable] 放行 asset 目录失败 {}: {e}",
            data_dir.display()
        );
    }
    let legacy = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[portable] 取旧数据目录失败，跳过迁移: {e}");
            return None;
        }
    };
    if legacy == data_dir {
        return None;
    }
    let report = migrate_legacy_data(&legacy, data_dir);
    if report.has_report() {
        Some(report)
    } else {
        None
    }
}

/// 把旧数据根里需要随包走的两类目录**复制**到便携数据根。
///
/// 语义刻意是复制而不是移动，且只在目标缺失时复制：
/// - 复制：旧位置无人清理时用户还能回滚，不存在「搬一半丢了」的窗口；
/// - 目标已存在就跳过（不合并、不覆盖）：两次运行叠加出互相矛盾的两套数据，
///   比少迁一次更难收拾；此时也不记入报告，否则每次启动都会重复提示。
pub fn migrate_legacy_data(legacy: &Path, target: &Path) -> PortableMigration {
    let mut report = PortableMigration {
        from: legacy.display().to_string(),
        to: target.display().to_string(),
        ..Default::default()
    };
    for name in MIGRATED_SUBDIRS {
        let source = legacy.join(name);
        let destination = target.join(name);
        if !source.is_dir() {
            // 旧位置本来就没有这类数据（全新机器 / 从没用过安装版）
            continue;
        }
        if destination.exists() {
            // 已经搬过（或用户自己在便携目录里先建好了）——不合并、不覆盖
            continue;
        }
        match copy_tree_atomically(&source, &destination, &mut report.skipped) {
            Ok(()) => report.copied.push(name.to_string()),
            Err(e) => report
                .failed
                .push(format!("{name}: 复制失败 {e}")),
        }
    }
    report
}

/// 先整树复制到同级临时目录，成功后再改名，避免「复制到一半中断」留下半份主题目录，
/// 让下一次启动误以为已经迁移完成。
fn copy_tree_atomically(
    source: &Path,
    destination: &Path,
    skipped: &mut Vec<String>,
) -> std::io::Result<()> {
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data".to_string());
    let staging = destination.with_file_name(format!(".{name}.migrating"));
    // 上一次中断留下的临时目录先清掉，否则复制会撞上残留文件
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    copy_dir_recursive(source, &staging, skipped)?;
    if let Err(e) = std::fs::rename(&staging, destination) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(())
}

/// 递归复制；**不跟随符号链接**（跟随会把链接目标的内容复制成实体，便携包反而不再
/// 自洽），被跳过的相对路径记进 `skipped`，由调用方交给用户看。
fn copy_dir_recursive(source: &Path, destination: &Path, skipped: &mut Vec<String>) -> std::io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let path = entry.path();
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_symlink() {
            skipped.push(format!("{}: 符号链接，未迁移", path.display()));
            continue;
        }
        if file_type.is_dir() {
            copy_dir_recursive(&path, &target, skipped)?;
        } else {
            std::fs::copy(&path, &target)?;
        }
    }
    Ok(())
}

/// 首启迁移结果的一次性取用位（与 `PendingFile` 同款：前端取走即清空）
pub struct PortableMigrationState(pub Mutex<Option<PortableMigration>>);

/// 应用数据根（前端 themes / recovery 的唯一来源）。
///
/// 必须与 Rust 侧 `write_recovery_file` 的路径守卫同源：前端若继续用
/// `@tauri-apps/api/path` 的 `appDataDir()`，便携模式下算出来的路径会被判越界。
#[tauri::command]
pub fn app_data_root(app: tauri::AppHandle) -> Result<String, String> {
    resolve_app_data_dir(&app).map(|dir| dir.display().to_string())
}

/// 取走本次启动的首启迁移结果（没有则 `None`）；前端据此给用户明确提示。
#[tauri::command]
pub fn take_portable_migration(
    state: tauri::State<'_, PortableMigrationState>,
) -> Option<PortableMigration> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU32, Ordering};

    static NEXT_DIR: AtomicU32 = AtomicU32::new(0);

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(label: &str) -> Self {
            let seq = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "inklingmd-app-paths-{label}-{}-{seq}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).expect("创建临时目录");
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn portable_marker_decides_data_dir() {
        let exe = Path::new("D:/Portable/InklingMD.exe");
        assert_eq!(
            portable_data_dir_from_exe(exe, true),
            Some(PathBuf::from("D:/Portable/data"))
        );
        // 没有标记文件 = 安装版：绝不能把数据根悄悄挪走
        assert_eq!(portable_data_dir_from_exe(exe, false), None);
    }

    #[test]
    fn migration_copies_themes_and_recovery_without_touching_source() {
        let root = TempDir::new("copy");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(legacy.join("themes/aurora")).expect("建旧主题目录");
        fs::write(legacy.join("themes/aurora/aurora.css"), "body{color:red}").expect("写主题");
        fs::create_dir_all(legacy.join("recovery/main")).expect("建旧恢复目录");
        fs::write(legacy.join("recovery/temp-kept.json"), "{}").expect("写登记表");
        // 不属于迁移范围的数据不得被带走（每个 issue 的假设都靠这条兜住）
        fs::write(legacy.join("unrelated.txt"), "keep").expect("写无关文件");

        let report = migrate_legacy_data(&legacy, &portable);

        assert_eq!(report.copied, vec!["themes".to_string(), "recovery".to_string()]);
        assert!(report.failed.is_empty(), "不应有失败项: {:?}", report.failed);
        assert!(report.has_report());
        assert_eq!(
            fs::read_to_string(portable.join("themes/aurora/aurora.css")).expect("便携目录应有主题"),
            "body{color:red}"
        );
        assert!(portable.join("recovery/temp-kept.json").is_file());
        assert!(!portable.join("unrelated.txt").exists());
        // 复制而非移动：旧位置原样保留，用户可回滚
        assert!(legacy.join("themes/aurora/aurora.css").is_file());
    }

    #[test]
    fn migration_is_silent_when_nothing_to_move_or_already_moved() {
        let root = TempDir::new("silent");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(&legacy).expect("建旧数据根");

        // 全新机器（旧位置没有 themes/recovery）：不产生任何报告，否则每次启动都弹窗
        let empty = migrate_legacy_data(&legacy, &portable);
        assert!(!empty.has_report(), "空旧目录不应产生报告: {empty:?}");

        // 第二次启动：目标已存在 → 既不复制也不报告（不合并、不覆盖）
        fs::create_dir_all(legacy.join("themes")).expect("建旧主题目录");
        fs::write(legacy.join("themes/old.css"), "old").expect("写旧主题");
        fs::create_dir_all(portable.join("themes")).expect("建便携主题目录");
        fs::write(portable.join("themes/new.css"), "new").expect("写便携主题");
        let second = migrate_legacy_data(&legacy, &portable);
        assert!(!second.has_report(), "已迁移过不应重复报告: {second:?}");
        assert!(!portable.join("themes/old.css").exists(), "不得合并旧数据");
        assert_eq!(
            fs::read_to_string(portable.join("themes/new.css")).expect("便携主题应保留"),
            "new"
        );
    }

    #[test]
    fn migration_skips_symlinks_and_reports_them() {
        let root = TempDir::new("symlink");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(legacy.join("themes")).expect("建旧主题目录");
        fs::write(legacy.join("themes/real.css"), "real").expect("写主题");
        let link = legacy.join("themes/link.css");
        #[cfg(unix)]
        let linked = std::os::unix::fs::symlink(legacy.join("themes/real.css"), &link);
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_file(legacy.join("themes/real.css"), &link);
        if linked.is_err() {
            // 无符号链接权限（Windows 非管理员 / 开发者模式关闭）：跳过该断言
            return;
        }

        let report = migrate_legacy_data(&legacy, &portable);

        assert_eq!(report.copied, vec!["themes".to_string()]);
        assert_eq!(report.skipped.len(), 1, "符号链接必须显式登记: {:?}", report.skipped);
        assert!(report.skipped[0].contains("符号链接"));
        assert!(portable.join("themes/real.css").is_file());
        assert!(!portable.join("themes/link.css").exists());
    }
}
