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
//!
//! 平台边界：便携模式目前只随 Windows 便携 ZIP 交付（`portable.txt` 只打进那个包）。
//! 非 Windows 上若用户自己放了这个文件，应用数据根照样会搬走，但 WebView2 那层
//! （`WEBVIEW2_USER_DATA_FOLDER`）只存在于 Windows —— 即「浏览器数据留系统目录、
//! 应用数据随身」的半迁移，属于已知边界，不是本模块可以补齐的。

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;

/// 便携模式标记文件名（必须与 exe 同目录）
pub const PORTABLE_MARKER: &str = "portable.txt";
/// 便携数据的目录名（exe 同级）
pub const PORTABLE_DATA_DIR: &str = "data";
/// 迁移结算标记（内容见 [`MigrationMarker`]）。**按子目录结算**，不是「文件存在就整体停迁」：
/// 已结算的子目录不再检查；旧位置当时缺失/为空或上次失败的子目录，每次启动都还会检查。
pub const MIGRATION_MARKER: &str = ".migrated-from-appdata";
/// 需要随包搬走的数据子目录（旧位置 → 便携位置）
pub const MIGRATED_SUBDIRS: [&str; 2] = ["themes", "recovery"];

/// 便携模式首启时从旧位置复制过来的结果。
///
/// 三个清单都为空且没有 warnings = 没有可报告的事，前端不弹提示。
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
    /// 有意跳过的条目（符号链接、旧位置不是目录、便携目录已有数据等，含原因）
    pub skipped: Vec<String>,
    /// 不属于迁移但同样需要用户知道的启动问题（asset scope 放行失败、旧目录取不到等）。
    /// release 是 `windows_subsystem = "windows"`，没有控制台，eprintln 没人看得到，
    /// 这类失败只能借这条通道送到界面上。
    pub warnings: Vec<String>,
}

impl PortableMigration {
    /// 是否有需要告知用户的内容
    pub fn has_report(&self) -> bool {
        !self.copied.is_empty()
            || !self.failed.is_empty()
            || !self.skipped.is_empty()
            || !self.warnings.is_empty()
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

/// 应用数据根：便携模式 → exe 同级 `data/`；安装版 → `app_data_dir()`。
///
/// 两条分支都保证目录存在（前端契约：拿到就能写），失败时返回可读原因。
pub fn resolve_app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = match portable_data_dir() {
        Some(dir) => dir,
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| format!("取应用数据目录失败: {e}"))?,
    };
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("创建应用数据目录失败 {}: {e}", dir.display()))?;
    Ok(dir)
}

/// 便携模式启动准备：放行 asset scope + 从旧位置迁移数据。
///
/// 返回 `None` 表示非便携模式（安装版路径完全不变），或没有任何需要告知用户的内容。
///
/// asset scope 是这条改动的硬前置：`tauri.conf.json` 的静态 scope 只有 `$APPDATA/**`
/// 与 `$APPLOCALDATA/**`，覆盖不到 exe 同级目录；主题 CSS 里的 `url()` 资源经
/// `convertFileSrc` 走 asset 协议，不放行就会被判越界、字体/图片静默降级。
/// 放行机制与工作区图片相同（`allow_asset_dir` → `asset_protocol_scope().allow_directory`），
/// 只是这里在窗口创建前做一次。
///
/// **只放行主题目录，不放行整个 `data/`**：WebView2 的 profile（cookies / localStorage）
/// 也在 `data/` 下，没有理由让 asset 协议够得着它。
pub fn prepare_portable_session(
    app: &tauri::AppHandle,
    data_dir: &Path,
) -> Option<PortableMigration> {
    if portable_data_dir().is_none() {
        return None;
    }
    let mut report = PortableMigration {
        to: data_dir.display().to_string(),
        ..Default::default()
    };
    // 目录必须存在：`allow_directory` 会对模式做 canonicalize
    let themes_dir = data_dir.join("themes");
    if let Err(e) = std::fs::create_dir_all(&themes_dir) {
        report.warnings.push(format!(
            "创建主题目录失败 {}: {e}",
            themes_dir.display()
        ));
    } else if let Err(e) = app.asset_protocol_scope().allow_directory(&themes_dir, true) {
        report.warnings.push(format!(
            "主题目录未加入 asset 白名单，主题里的图片/字体将无法加载 {}: {e}",
            themes_dir.display()
        ));
    }
    match app.path().app_data_dir() {
        Ok(legacy) if legacy != data_dir => {
            // 先填来源：即使本次什么都没迁（已结算 / 全部失败），弹窗里的「来源」也得有值
            report.from = legacy.display().to_string();
            let migration = migrate_legacy_data(&legacy, data_dir);
            if !migration.from.is_empty() {
                report.from = migration.from;
            }
            report.copied = migration.copied;
            report.failed = migration.failed;
            report.skipped = migration.skipped;
            report.warnings.extend(migration.warnings);
        }
        Ok(_) => {}
        Err(e) => report
            .warnings
            .push(format!("取旧数据目录失败，本次未迁移旧数据: {e}")),
    }
    if report.has_report() {
        Some(report)
    } else {
        None
    }
}

/// 旧位置条目的类型判定结果。**必须区分「不存在」与「读不到」**：
/// `Path::is_dir()` 在元数据读取失败时同样返回 false，把它当成「没有数据」会
/// 让一次权限/占用故障变成永久静默不迁移。
#[derive(Debug, PartialEq, Eq)]
enum SourceKind {
    Missing,
    Symlink,
    NotDir,
    Dir,
    Error(String),
}

fn source_kind(path: &Path) -> SourceKind {
    match std::fs::symlink_metadata(path) {
        Ok(meta) if meta.file_type().is_symlink() => SourceKind::Symlink,
        Ok(meta) if meta.is_dir() => SourceKind::Dir,
        Ok(_) => SourceKind::NotDir,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => SourceKind::Missing,
        Err(e) => SourceKind::Error(e.to_string()),
    }
}

/// 目标目录状态：区分「缺失」「空目录」「已有内容」。
///
/// 「空目录」这一档是必需的：应用自己会在首启把 `data/themes` 建出来（`ensureDir`），
/// 只看 `exists()` 会把「空目录」误判成「已经迁过了」，之后永远不再迁移。
#[derive(Debug, PartialEq, Eq)]
enum DestState {
    Missing,
    Empty,
    NonEmpty,
    Error(String),
}

/// 区分 `read_dir().next()` 的三态：`None`（空目录）、`Some(Ok(_))`（非空）、`Some(Err(e))`（迭代失败）。
/// 必须把 `Some(Err(_))` 拆成 `DestState::Error`，否则一次瞬时迭代故障会被误判成
/// `DestState::NonEmpty` 并永久结算为 `skipped:non-empty`。
fn classify_first_entry<T>(first: Option<std::io::Result<T>>) -> DestState {
    match first {
        None => DestState::Empty,
        Some(Ok(_)) => DestState::NonEmpty,
        Some(Err(e)) => DestState::Error(e.to_string()),
    }
}

fn destination_state(path: &Path) -> DestState {
    match std::fs::read_dir(path) {
        Ok(mut entries) => classify_first_entry(entries.next()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DestState::Missing,
        Err(e) => DestState::Error(e.to_string()),
    }
}

/// 迁移状态的落地形态（[`MIGRATION_MARKER`] 的内容）。
///
/// `settled` 是**逐子目录**的结算状态：已经有结论的子目录下次启动静默跳过；
/// 没有条目的子目录每次启动都还会检查，包括：
/// - 旧位置当时缺失（`SourceKind::Missing`）——之后装过安装版才可能有数据；
/// - 旧位置当时是空目录——之后才可能放进主题；
/// - 上次读取/复制失败——需要重试。
/// 单文件 + 逐子目录状态，才能同时满足两件互相拉扯的事：
/// 「迁过就别再迁」（否则用户删掉的主题会被旧位置复活）与
/// 「当时没数据就别把门关死」（否则用户之后用安装版产生数据就永远迁不过来）。
#[derive(Debug, Default, serde::Serialize, serde::Deserialize)]
struct MigrationMarker {
    #[serde(default)]
    from: String,
    #[serde(default)]
    to: String,
    #[serde(default)]
    at: u64,
    /// 子目录名 → `copied` / `skipped:<原因>`
    #[serde(default)]
    settled: std::collections::BTreeMap<String, String>,
}

fn read_migration_marker(target: &Path) -> MigrationMarker {
    std::fs::read(target.join(MIGRATION_MARKER))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// 把旧数据根里需要随包走的两类目录**复制**到便携数据根。
///
/// 语义刻意是复制而不是移动，且只在目标缺失/为空时复制：
/// - 复制：旧位置无人清理时用户还能回滚，不存在「搬一半丢了」的窗口；
/// - 目标已有内容就跳过（不合并、不覆盖）：两次运行叠加出互相矛盾的两套数据，
///   比少迁一次更难收拾。跳过会进 `skipped` 让用户看见，并结算成 `skipped:*`，
///   由 [`MIGRATION_MARKER`] 抑制重复提示。
pub fn migrate_legacy_data(legacy: &Path, target: &Path) -> PortableMigration {
    migrate_legacy_data_with(legacy, target, dir_has_entries, destination_state)
}

fn migrate_legacy_data_with(
    legacy: &Path,
    target: &Path,
    check_has_entries: impl Fn(&Path) -> std::io::Result<bool>,
    check_dest_state: impl Fn(&Path) -> DestState,
) -> PortableMigration {
    let mut report = PortableMigration {
        from: legacy.display().to_string(),
        to: target.display().to_string(),
        ..Default::default()
    };
    let mut marker = read_migration_marker(target);
    marker.from = report.from.clone();
    marker.to = report.to.clone();
    let mut marker_dirty = false;
    for name in MIGRATED_SUBDIRS {
        if marker.settled.contains_key(name) {
            // 这个子目录已有结论（迁过 / 判定为不可迁）：不再迁、也不再提示
            continue;
        }
        let source = legacy.join(name);
        let destination = target.join(name);
        match source_kind(&source) {
            SourceKind::Missing => continue,
            SourceKind::Symlink => {
                report.skipped.push(format!(
                    "{name}: 旧位置是符号链接，未跟随复制（如需搬走请直接复制链接目标）"
                ));
                marker
                    .settled
                    .insert(name.to_string(), "skipped:symlink".to_string());
                marker_dirty = true;
                continue;
            }
            SourceKind::NotDir => {
                report.skipped.push(format!("{name}: 旧位置同名项不是目录"));
                marker
                    .settled
                    .insert(name.to_string(), "skipped:not-dir".to_string());
                marker_dirty = true;
                continue;
            }
            SourceKind::Error(e) => {
                // 读不到不等于没有：不结算，下次启动重试
                report.failed.push(format!("{name}: 读取旧位置失败 {e}"));
                continue;
            }
            SourceKind::Dir => match check_has_entries(&source) {
                Ok(true) => {}
                Ok(false) => {
                    // 旧位置是空目录：现在没什么可搬。**不能结算** ——
                    // 否则用户之后真往里放东西，就永远不会再迁了
                    continue;
                }
                Err(e) => {
                    // 打开或遍历旧目录失败：不得当成「空目录」静默跳过，也不结算，下次启动重试
                    report.failed.push(format!("{name}: 读取旧位置失败 {e}"));
                    continue;
                }
            },
        }
        let dest_is_empty = match check_dest_state(&destination) {
            DestState::Missing => false,
            DestState::Empty => true,
            DestState::NonEmpty => {
                report.skipped.push(format!(
                    "{name}: 便携目录已有数据，未合并（需要的话请手动复制旧位置的内容）"
                ));
                marker
                    .settled
                    .insert(name.to_string(), "skipped:non-empty".to_string());
                marker_dirty = true;
                continue;
            }
            DestState::Error(e) => {
                report
                    .failed
                    .push(format!("{name}: 读取便携目录失败 {}: {e}", destination.display()));
                continue;
            }
        };
        let skipped_before = report.skipped.len();
        match copy_tree_atomically(&source, &destination, dest_is_empty, &mut report.skipped) {
            Ok(0) => {
                // 仅含符号链接（实际复制 0 个文件）：不得放入 report.copied，按跳过结算且不落空目录
                if report.skipped.len() > skipped_before {
                    marker
                        .settled
                        .insert(name.to_string(), "skipped:symlink".to_string());
                    marker_dirty = true;
                }
            }
            Ok(_) => {
                report.copied.push(name.to_string());
                marker.settled.insert(name.to_string(), "copied".to_string());
                marker_dirty = true;
            }
            Err(e) => report.failed.push(format!("{name}: 复制失败 {e}")),
        }
    }
    if marker_dirty {
        marker.at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if let Err(e) = write_migration_marker(target, &marker) {
            // 标记写不进去 = 下次启动会重新检查迁移状态；这本身不是数据问题，
            // 但「为什么之后又弹出一次迁移提示」必须能从界面上查到
            report.warnings.push(format!(
                "迁移状态标记写入失败（下次启动会重新检查迁移状态）: {e}"
            ));
        }
    }
    report
}

/// 目录里是否有**文件级**条目（递归：只有空子目录也算「没内容」）。
///
/// 只判一层 `read_dir().next()` 会把「只有空 `.staging/`」的旧主题目录当成有数据，
/// 结果什么都没复制却结算成 `copied`，弹窗说「已复制」，此后该子目录永远不再迁移。
/// 符号链接算条目（不跟随，交给复制阶段登记为 skipped）；打开目录、读取条目或获取
/// 文件类型失败时显式传播 `Err`，由调用方记入 `report.failed` 且不结算，避免静默跳过。
fn dir_has_entries(path: &Path) -> std::io::Result<bool> {
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_dir() {
            return Ok(true);
        }
        if dir_has_entries(&entry.path())? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn write_migration_marker(target: &Path, marker: &MigrationMarker) -> Result<(), String> {
    // 生产路径上 `resolve_app_data_dir` 已经建好目录；这里兜一次是为了让
    // 「标记一定和迁移结果同时落地」不依赖调用顺序
    std::fs::create_dir_all(target)
        .map_err(|e| format!("建目录失败 {}: {e}", target.display()))?;
    let body = serde_json::to_vec(marker).map_err(|e| format!("序列化失败: {e}"))?;
    // 先写临时文件再改名：直接覆盖时若中途崩溃，标记会变成半截 JSON，
    // 解析失败就会退化成「什么都没结算」，把用户删掉的主题整树复制回来
    let final_path = target.join(MIGRATION_MARKER);
    let staging = target.join(format!("{MIGRATION_MARKER}.tmp"));
    std::fs::write(&staging, body)
        .map_err(|e| format!("写入失败 {}: {e}", staging.display()))?;
    if let Err(e) = std::fs::rename(&staging, &final_path) {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("改名失败 {}: {e}", final_path.display()));
    }
    Ok(())
}

/// 先整树复制到同级临时目录，成功且实际复制文件数 > 0 后再改名落位，避免「复制到一半中断」
/// 留下半份主题目录，或「仅含符号链接（0 个文件）」时留下无意义的空结构覆盖目标。
///
/// 返回实际复制的普通文件数量。
fn copy_tree_atomically(
    source: &Path,
    destination: &Path,
    dest_is_empty: bool,
    skipped: &mut Vec<String>,
) -> std::io::Result<usize> {
    let name = destination
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "data".to_string());
    let staging = destination.with_file_name(format!(".{name}.migrating"));
    // 上一次中断留下的临时目录先清掉，否则复制会撞上残留文件
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?;
    }
    // 复制失败同样清掉半成品：否则 data/ 下会留下一个既没结算、也不在白名单里的
    // `.themes.migrating`，用户拷走便携包时带上一份不完整数据
    let copied_files = match copy_dir_recursive(source, &staging, skipped) {
        Ok(count) => count,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    if copied_files == 0 {
        // 0 个普通文件被复制（例如子目录内仅含符号链接）：清理临时目录且不覆盖目标
        let _ = std::fs::remove_dir_all(&staging);
        return Ok(0);
    }
    if dest_is_empty {
        // 应用自己建出来的空目录：只有确认真有文件要落位时才清掉再 rename
        if let Err(e) = std::fs::remove_dir(destination) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(e);
        }
    }
    if let Err(e) = std::fs::rename(&staging, destination) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    Ok(copied_files)
}

/// 递归复制；**不跟随符号链接**（跟随会把链接目标的内容复制成实体，便携包反而不再
/// 自洽），被跳过的源路径（`path.display()`）记进 `skipped`，由调用方交给用户看。返回实际复制的文件数。
fn copy_dir_recursive(
    source: &Path,
    destination: &Path,
    skipped: &mut Vec<String>,
) -> std::io::Result<usize> {
    std::fs::create_dir_all(destination)?;
    let mut copied = 0usize;
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
            copied += copy_dir_recursive(&path, &target, skipped)?;
        } else {
            std::fs::copy(&path, &target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// release 是 GUI 子系统进程（`windows_subsystem = "windows"`），`eprintln!` 没有任何
/// 接收方。启动期还没拿到前端通道的致命错误，至少落到临时目录的一份日志里可供排查。
pub fn record_startup_error(message: &str) {
    eprintln!("[app-path] {message}");
    let dir = std::env::temp_dir().join("inklingmd");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("startup-error.log"))
    {
        let _ = writeln!(file, "{message}");
    }
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

    /// 造一份「旧位置有主题与恢复区」的现场，返回 (legacy, portable)
    fn seed_legacy(root: &Path) -> (PathBuf, PathBuf) {
        let legacy = root.join("roaming");
        let portable = root.join("data");
        fs::create_dir_all(legacy.join("themes/aurora")).expect("建旧主题目录");
        fs::write(legacy.join("themes/aurora/aurora.css"), "body{color:red}").expect("写主题");
        fs::create_dir_all(legacy.join("recovery/main")).expect("建旧恢复目录");
        fs::write(legacy.join("recovery/temp-kept.json"), "{}").expect("写登记表");
        (legacy, portable)
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
    fn serialized_keys_match_the_frontend_contract() {
        // 前端 `PortableMigration` 接口逐字依赖这些键名；改名/加 rename_all 会让弹窗
        // 拿不到 failed/skipped（读取 undefined 直接抛错），而两侧单测都察觉不到
        let value = serde_json::to_value(PortableMigration::default()).expect("可序列化");
        let mut keys: Vec<String> = value
            .as_object()
            .expect("对象")
            .keys()
            .cloned()
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            vec![
                "copied".to_string(),
                "failed".to_string(),
                "from".to_string(),
                "skipped".to_string(),
                "to".to_string(),
                "warnings".to_string(),
            ]
        );
    }

    #[test]
    fn migration_copies_themes_and_recovery_without_touching_source() {
        let root = TempDir::new("copy");
        let (legacy, portable) = seed_legacy(root.path());
        // 不属于迁移范围的数据不得被带走（每个 issue 的假设都靠这条兜住）
        fs::write(legacy.join("unrelated.txt"), "keep").expect("写无关文件");

        let report = migrate_legacy_data(&legacy, &portable);

        assert_eq!(
            report.copied,
            vec!["themes".to_string(), "recovery".to_string()]
        );
        assert!(report.failed.is_empty(), "不应有失败项: {:?}", report.failed);
        assert!(report.skipped.is_empty(), "不应有跳过项: {:?}", report.skipped);
        assert!(report.has_report());
        assert_eq!(
            fs::read_to_string(portable.join("themes/aurora/aurora.css")).expect("便携目录应有主题"),
            "body{color:red}"
        );
        assert!(portable.join("recovery/temp-kept.json").is_file());
        assert!(!portable.join("unrelated.txt").exists());
        // 复制而非移动：旧位置原样保留，用户可回滚
        assert!(legacy.join("themes/aurora/aurora.css").is_file());
        assert!(portable.join(MIGRATION_MARKER).is_file(), "完成后应写迁移标记");
    }

    #[test]
    fn migration_is_silent_when_nothing_to_move_or_already_moved() {
        let root = TempDir::new("silent");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(&legacy).expect("建旧数据根");

        // 全新机器（旧位置没有 themes/recovery）：不产生任何报告，否则每次启动都弹窗；
        // 也不能写标记 —— 用户之后装了安装版再来，仍要能迁移
        let empty = migrate_legacy_data(&legacy, &portable);
        assert!(!empty.has_report(), "空旧目录不应产生报告: {empty:?}");
        assert!(!portable.join(MIGRATION_MARKER).exists(), "没数据时不得写标记");

        // 之后旧位置有了数据、便携目录还是空的 → 必须仍能迁移（F3 的真实场景）
        fs::create_dir_all(legacy.join("themes")).expect("建旧主题目录");
        fs::write(legacy.join("themes/old.css"), "old").expect("写旧主题");
        let later = migrate_legacy_data(&legacy, &portable);
        assert_eq!(later.copied, vec!["themes".to_string()]);
        assert_eq!(
            fs::read_to_string(portable.join("themes/old.css")).expect("应迁入"),
            "old"
        );

        // 再启动一次：标记已写 → 不复制、不报告（删掉的主题不会被复活）
        fs::write(legacy.join("themes/resurrect.css"), "back").expect("写新主题");
        let again = migrate_legacy_data(&legacy, &portable);
        assert!(!again.has_report(), "已迁移过不应重复报告: {again:?}");
        assert!(!portable.join("themes/resurrect.css").exists(), "不得再次迁入");
    }

    #[test]
    fn migration_into_app_created_empty_dir_still_happens() {
        // 应用自己会在首启把 data/themes 建出来（ensureDir）：空目录不能算「已迁移」
        let root = TempDir::new("emptydir");
        let (legacy, portable) = seed_legacy(root.path());
        fs::create_dir_all(portable.join("themes")).expect("建空主题目录");

        let report = migrate_legacy_data(&legacy, &portable);

        assert_eq!(report.copied, vec!["themes".to_string(), "recovery".to_string()]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert!(portable.join("themes/aurora/aurora.css").is_file());
    }

    #[test]
    fn legacy_dir_with_only_empty_subdirs_does_not_settle_migration() {
        // 旧位置的 themes 里只有空目录（导入主题留下的空 .staging 之类）：一个文件都没有，
        // 不能结算成 copied —— 否则弹窗会说「已复制」，而且此后该子目录永远不再迁移
        let root = TempDir::new("only-empty-dirs");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(legacy.join("themes/.staging")).expect("建空子目录");

        let nothing = migrate_legacy_data(&legacy, &portable);

        assert!(nothing.copied.is_empty(), "只有空子目录时不该算复制: {nothing:?}");
        assert!(!nothing.has_report(), "没有可搬内容时不该有报告: {nothing:?}");
        assert!(
            !portable.join(MIGRATION_MARKER).exists(),
            "只有空子目录不得结算（否则之后放进来就永远不迁）"
        );

        // 之后真放了一个文件 → 必须迁入
        fs::write(legacy.join("themes/real.css"), "real").expect("写主题");
        let later = migrate_legacy_data(&legacy, &portable);
        assert_eq!(later.copied, vec!["themes".to_string()]);
        assert!(portable.join("themes/real.css").is_file());
    }

    #[test]
    fn empty_legacy_dir_does_not_settle_migration() {
        // 安装版首启就会 ensureDir 出 themes/，所以「旧位置有 themes 但空」是常态。
        // 这一刻没东西可搬，但绝不能结算：否则用户之后放进来的主题永远迁不过来
        let root = TempDir::new("emptysource");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(legacy.join("themes")).expect("建空的旧主题目录");

        let nothing = migrate_legacy_data(&legacy, &portable);
        assert!(!nothing.has_report(), "没内容可搬时不该有报告: {nothing:?}");
        assert!(
            !portable.join(MIGRATION_MARKER).exists(),
            "空源目录不得结算（否则之后放进来的主题永远不迁）"
        );

        // 之后旧位置真有主题了 → 必须迁移
        fs::write(legacy.join("themes/late.css"), "late").expect("写主题");
        let later = migrate_legacy_data(&legacy, &portable);
        assert_eq!(later.copied, vec!["themes".to_string()]);
        assert_eq!(
            fs::read_to_string(portable.join("themes/late.css")).expect("应迁入"),
            "late"
        );
    }

    #[test]
    fn settled_migration_keeps_source_path_for_the_report() {
        // 「来源」是弹窗里唯一告诉用户旧数据在哪的字段：结算后再次调用不能把它清成空串
        let root = TempDir::new("settled");
        let (legacy, portable) = seed_legacy(root.path());
        migrate_legacy_data(&legacy, &portable);

        let again = migrate_legacy_data(&legacy, &portable);

        assert!(!again.has_report(), "已结算不应重复报告: {again:?}");
        assert_eq!(again.from, legacy.display().to_string());
        assert_eq!(again.to, portable.display().to_string());
    }

    #[test]
    fn migration_reports_non_empty_target_instead_of_merging() {
        let root = TempDir::new("nonempty");
        let (legacy, portable) = seed_legacy(root.path());
        fs::create_dir_all(portable.join("themes")).expect("建便携主题目录");
        fs::write(portable.join("themes/mine.css"), "mine").expect("写便携主题");

        let report = migrate_legacy_data(&legacy, &portable);

        // 主题不合并（不覆盖用户自己的），但必须进 skipped 让用户看见
        assert_eq!(report.copied, vec!["recovery".to_string()]);
        assert!(
            report.skipped.iter().any(|s| s.contains("themes") && s.contains("未合并")),
            "已有数据必须显式登记: {:?}",
            report.skipped
        );
        assert!(!portable.join("themes/aurora/aurora.css").exists(), "不得合并");
        assert_eq!(
            fs::read_to_string(portable.join("themes/mine.css")).expect("便携主题应保留"),
            "mine"
        );
    }

    /// 注意：`SourceKind::Error`（元数据读失败）这条分支在本机无法稳定制造
    /// （需要权限/占用故障，CI 以 root 跑 chmod 场景会失效），这里只覆盖「同名项不是目录」。
    #[test]
    fn migration_reports_non_directory_sources() {
        let root = TempDir::new("nondir");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        fs::create_dir_all(&legacy).expect("建旧数据根");
        // 旧位置的 themes 是个文件：既不能静默当成「没有数据」，也不能当目录读
        fs::write(legacy.join("themes"), "not a dir").expect("写同名文件");

        let report = migrate_legacy_data(&legacy, &portable);

        assert!(report.copied.is_empty());
        assert!(
            report.skipped.iter().any(|s| s.contains("themes") && s.contains("不是目录")),
            "非目录必须显式登记: {:?}",
            report.skipped
        );
        // 有内容可处理 → 写标记，避免每次启动重复提示
        assert!(portable.join(MIGRATION_MARKER).is_file());
    }

    #[cfg(unix)]
    #[test]
    fn migration_skips_symlinks_and_reports_them() {
        let root = TempDir::new("symlink");
        let (legacy, portable) = seed_legacy(root.path());
        std::os::unix::fs::symlink(legacy.join("themes/aurora/aurora.css"), legacy.join("themes/link.css"))
            .expect("创建符号链接");

        let report = migrate_legacy_data(&legacy, &portable);

        assert_eq!(report.copied, vec!["themes".to_string(), "recovery".to_string()]);
        assert_eq!(
            report.skipped.len(),
            1,
            "符号链接必须显式登记: {:?}",
            report.skipped
        );
        assert!(report.skipped[0].contains("符号链接"));
        assert!(portable.join("themes/aurora/aurora.css").is_file());
        assert!(!portable.join("themes/link.css").exists());
    }

    #[cfg(unix)]
    #[test]
    fn migration_does_not_follow_symlinked_source_root() {
        // 旧位置的 themes 本身是链接：跟随复制会把链接目标变成实体副本
        let root = TempDir::new("symlink-root");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        let real = root.path().join("elsewhere");
        fs::create_dir_all(&real).expect("建目标目录");
        fs::write(real.join("x.css"), "x").expect("写主题");
        fs::create_dir_all(&legacy).expect("建旧数据根");
        std::os::unix::fs::symlink(&real, legacy.join("themes")).expect("创建目录链接");

        let report = migrate_legacy_data(&legacy, &portable);

        assert!(report.copied.is_empty(), "不得跟随符号链接复制: {report:?}");
        assert!(report.skipped.iter().any(|s| s.contains("符号链接")), "{:?}", report.skipped);
        assert!(!portable.join("themes/x.css").exists());
    }

    #[test]
    fn dir_has_entries_propagates_read_dir_errors() {
        let root = TempDir::new("dir-has-entries-err");
        let file_path = root.path().join("not-a-dir.css");
        fs::write(&file_path, "body{}").expect("写普通文件");

        // 传入普通文件会触发 read_dir 失败：必须显式返回 Err，不得静默吞成 Ok(false)
        let err = dir_has_entries(&file_path).expect_err("read_dir 失败必须返回 Err");
        assert!(!err.to_string().is_empty());

        let empty_tree = root.path().join("empty-tree/.staging");
        fs::create_dir_all(&empty_tree).expect("建空子目录");
        assert!(!dir_has_entries(&root.path().join("empty-tree")).expect("空子目录应返回 Ok(false)"));

        fs::write(empty_tree.join("a.css"), "h1{}").expect("写入真实文件");
        assert!(dir_has_entries(&root.path().join("empty-tree")).expect("含文件应返回 Ok(true)"));
    }

    #[test]
    fn migration_records_failure_and_does_not_settle_when_dir_scan_fails() {
        let root = TempDir::new("scan-err");
        let (legacy, portable) = seed_legacy(root.path());

        // 模拟扫描旧 themes 目录时返回 IO 错误（如列目录权限被拒）
        let report = migrate_legacy_data_with(
            &legacy,
            &portable,
            |path| {
                if path.file_name().and_then(|n| n.to_str()) == Some("themes") {
                    Err(std::io::Error::new(
                        std::io::ErrorKind::PermissionDenied,
                        "access denied",
                    ))
                } else {
                    dir_has_entries(path)
                }
            },
            destination_state,
        );

        assert_eq!(report.copied, vec!["recovery".to_string()]);
        assert!(
            report
                .failed
                .iter()
                .any(|f| f.contains("themes") && f.contains("access denied")),
            "扫描旧目录失败必须记入 report.failed: {:?}",
            report.failed
        );
        // recovery 已结算，但 themes 失败不得写入 settled —— 下次恢复可读后必须可重试迁入
        let marker = read_migration_marker(&portable);
        assert_eq!(marker.settled.get("recovery").map(String::as_str), Some("copied"));
        assert!(!marker.settled.contains_key("themes"));

        let retry = migrate_legacy_data(&legacy, &portable);
        assert_eq!(retry.copied, vec!["themes".to_string()]);
        assert!(retry.failed.is_empty(), "{:?}", retry.failed);
        assert!(portable.join("themes/aurora/aurora.css").is_file());
    }

    #[test]
    fn classify_first_entry_treats_iterator_error_as_error_not_non_empty() {
        assert_eq!(classify_first_entry::<()>(None), DestState::Empty);
        assert_eq!(classify_first_entry(Some(Ok(()))), DestState::NonEmpty);

        let iter_err = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "iter denied");
        assert_eq!(
            classify_first_entry::<()>(Some(Err(iter_err))),
            DestState::Error("iter denied".to_string())
        );
    }

    #[test]
    fn migration_records_failure_and_does_not_settle_on_destination_read_error() {
        let root = TempDir::new("dest-read-err");
        let (legacy, portable) = seed_legacy(root.path());
        fs::create_dir_all(&portable).expect("建便携数据根");
        // 目标路径被同名普通文件占据：read_dir 失败 → 进 report.failed 且不结算
        let blocker = portable.join("themes");
        fs::write(&blocker, "not a directory").expect("写占位文件");

        let report = migrate_legacy_data(&legacy, &portable);
        assert_eq!(report.copied, vec!["recovery".to_string()]);
        assert!(
            report.failed.iter().any(|f| f.contains("themes")),
            "目标读取失败必须进 failed: {:?}",
            report.failed
        );
        assert!(report.skipped.is_empty(), "读失败不得伪装成 skipped:non-empty: {:?}", report.skipped);
        let marker = read_migration_marker(&portable);
        assert!(!marker.settled.contains_key("themes"), "目标读失败不得结算: {marker:?}");

        // 模拟瞬时迭代失败（Some(Err) → DestState::Error）：同样进 failed、不结算，恢复后可迁入
        fs::remove_file(&blocker).expect("清占位文件");
        let transient = migrate_legacy_data_with(
            &legacy,
            &portable,
            dir_has_entries,
            |path| {
                if path.file_name().and_then(|n| n.to_str()) == Some("themes") {
                    classify_first_entry::<()>(Some(Err(std::io::Error::new(
                        std::io::ErrorKind::Other,
                        "transient read_dir iter error",
                    ))))
                } else {
                    destination_state(path)
                }
            },
        );
        assert!(transient.copied.is_empty());
        assert!(
            transient
                .failed
                .iter()
                .any(|f| f.contains("themes") && f.contains("transient read_dir iter error")),
            "{:?}",
            transient.failed
        );
        assert!(!read_migration_marker(&portable).settled.contains_key("themes"));

        let retry = migrate_legacy_data(&legacy, &portable);
        assert_eq!(retry.copied, vec!["themes".to_string()]);
        assert!(portable.join("themes/aurora/aurora.css").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn migration_with_only_symlinks_does_not_mark_copied() {
        let root = TempDir::new("only-symlinks");
        let legacy = root.path().join("roaming");
        let portable = root.path().join("data");
        let target = root.path().join("elsewhere/real.css");
        fs::create_dir_all(target.parent().unwrap()).expect("建目标目录");
        fs::write(&target, "body{}").expect("写真实主题");
        // 旧位置 themes 下只有符号链接（包含嵌套子目录中的符号链接），0 个真实文件
        fs::create_dir_all(legacy.join("themes/nested")).expect("建旧主题目录");
        std::os::unix::fs::symlink(&target, legacy.join("themes/nested/link.css"))
            .expect("创建符号链接");

        let report = migrate_legacy_data(&legacy, &portable);

        assert!(
            report.copied.is_empty(),
            "仅含符号链接（实际复制 0 个文件）不得记入 copied: {report:?}"
        );
        assert!(
            report.skipped.iter().any(|s| s.contains("符号链接")),
            "符号链接必须显式登记在 skipped: {:?}",
            report.skipped
        );
        assert!(
            !portable.join("themes").exists(),
            "0 文件复制不应在便携目录留下无意义的空结构"
        );
        assert!(portable.join(MIGRATION_MARKER).is_file(), "应写入跳过结算标记");
        assert_eq!(
            read_migration_marker(&portable)
                .settled
                .get("themes")
                .map(String::as_str),
            Some("skipped:symlink")
        );

        let again = migrate_legacy_data(&legacy, &portable);
        assert!(!again.has_report(), "已结算后再次启动应静默: {again:?}");

        // 目标目录本身已被应用先建为空目录时（prepare_portable_session 真实顺序），同样不落空子目录
        let root2 = TempDir::new("only-symlinks-empty-dest");
        let legacy2 = root2.path().join("roaming");
        let portable2 = root2.path().join("data");
        fs::create_dir_all(legacy2.join("themes/nested")).expect("建旧主题目录");
        fs::create_dir_all(portable2.join("themes")).expect("模拟首启已建空目录");
        std::os::unix::fs::symlink(&target, legacy2.join("themes/nested/link.css"))
            .expect("创建符号链接");

        let report2 = migrate_legacy_data(&legacy2, &portable2);
        assert!(report2.copied.is_empty(), "{report2:?}");
        assert!(report2.skipped.iter().any(|s| s.contains("符号链接")));
        assert!(
            !portable2.join("themes/nested").exists(),
            "不得把无意义空子目录搬进目标空目录"
        );
        assert_eq!(
            fs::read_dir(portable2.join("themes")).expect("目标目录应保持为空").count(),
            0
        );
    }
}
