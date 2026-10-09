//! #307 主题导入的 IO 层（扫描 / 递归复制 / 压缩包解压 / 预装目录解析）。
//!
//! 契约要点（issue #307 §2 / §3 / §9 / §10）：
//! - **符号链接一律不跟随**（§10：避免循环与越权）——扫描跳过、复制跳过并**登记**（不静默）；
//! - 压缩包解压必须做 **zip slip 防护**（§9）：条目解析后越出目标目录即拒绝整包；
//! - 隐藏项（`.` 开头，如 `.backup`）不进入扫描结果；
//! - 预装源副本 `$RESOURCE/themes`：dev（`tauri dev`）下 resource_dir 指向 `target/debug`，
//!   故回落到仓库内的 `src-tauri/resources/themes`，保证开发与 E2E 可用。

use serde::Serialize;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

/// 主题目录扫描结果（单层）
#[derive(Debug, Serialize)]
pub struct ThemeDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// 文件字节数（目录为 0）
    pub size: u64,
}

#[derive(Debug, Serialize)]
pub struct ThemeDirScan {
    pub entries: Vec<ThemeDirEntry>,
    /// 被跳过的项（符号链接等），供 UI/日志显式登记（不静默）
    pub skipped: Vec<String>,
}

/// 扫描主题目录**单层**：目录在前、文件在后（名称不区分大小写排序）；
/// 跳过隐藏项与**符号链接**（不跟随）。
#[tauri::command]
pub async fn scan_theme_dir(dir_path: String) -> Result<ThemeDirScan, String> {
    tauri::async_runtime::spawn_blocking(move || scan_theme_dir_sync(Path::new(&dir_path)))
        .await
        .map_err(|e| format!("主题目录扫描任务失败: {e}"))?
}

fn scan_theme_dir_sync(dir: &Path) -> Result<ThemeDirScan, String> {
    if !dir.exists() {
        // 主题目录尚未创建不是错误（首启自动创建由前端负责）：返回空扫描结果
        return Ok(ThemeDirScan { entries: Vec::new(), skipped: Vec::new() });
    }
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", dir.display()));
    }

    let mut entries: Vec<ThemeDirEntry> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let reader = fs::read_dir(dir).map_err(|e| format!("读取主题目录失败: {e}"))?;
    for item in reader {
        let item = item.map_err(|e| format!("读取主题目录项失败: {e}"))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue; // 隐藏项（含 `.backup`）：不进入清单
        }
        let path = item.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("读取元数据失败: {e}"))?;
        if meta.file_type().is_symlink() {
            skipped.push(format!("{}（符号链接，不跟随）", name));
            continue;
        }
        entries.push(ThemeDirEntry {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_file() { meta.len() } else { 0 },
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(ThemeDirScan { entries, skipped })
}

#[derive(Debug, Serialize)]
pub struct CopyReport {
    /// 实际复制的文件数
    pub files: usize,
    /// 复制的总字节数
    pub bytes: u64,
    /// 被跳过的项（符号链接等）
    pub skipped: Vec<String>,
}

/// 递归复制文件/目录（导入路径①的 `.css`、路径②的文件夹）。
/// 符号链接**不跟随**（跳过并登记）；`to` 的父目录会自动创建；同名文件**覆盖**（重名策略由前端决定）。
#[tauri::command]
pub async fn copy_path(from: String, to: String) -> Result<CopyReport, String> {
    tauri::async_runtime::spawn_blocking(move || copy_path_sync(Path::new(&from), Path::new(&to)))
        .await
        .map_err(|e| format!("复制任务失败: {e}"))?
}

fn copy_path_sync(from: &Path, to: &Path) -> Result<CopyReport, String> {
    let meta = fs::symlink_metadata(from).map_err(|e| format!("源路径不可读: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("源路径是符号链接（不跟随）: {}", from.display()));
    }
    if meta.is_file() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let bytes = fs::copy(from, to).map_err(|e| format!("复制文件失败: {e}"))?;
        return Ok(CopyReport { files: 1, bytes, skipped: Vec::new() });
    }
    if !meta.is_dir() {
        return Err(format!("不支持的源类型: {}", from.display()));
    }

    let mut report = CopyReport { files: 0, bytes: 0, skipped: Vec::new() };
    fs::create_dir_all(to).map_err(|e| format!("创建目录失败: {e}"))?;
    let reader = fs::read_dir(from).map_err(|e| format!("读取目录失败: {e}"))?;
    for item in reader {
        let item = item.map_err(|e| format!("读取目录项失败: {e}"))?;
        let child = item.path();
        let child_meta = fs::symlink_metadata(&child).map_err(|e| format!("读取元数据失败: {e}"))?;
        let name = item.file_name().to_string_lossy().into_owned();
        if child_meta.file_type().is_symlink() {
            report.skipped.push(format!("{}（符号链接，不跟随）", name));
            continue;
        }
        let dest = to.join(&name);
        if child_meta.is_dir() {
            let sub = copy_path_sync(&child, &dest)?;
            report.files += sub.files;
            report.bytes += sub.bytes;
            report.skipped.extend(sub.skipped);
        } else {
            let bytes = fs::copy(&child, &dest).map_err(|e| format!("复制文件失败: {e}"))?;
            report.files += 1;
            report.bytes += bytes;
        }
    }
    Ok(report)
}

// ── 压缩包解压（§3.1 + §9 zip slip） ────────────────────────────────────────

/// 单个条目解压上限（8 MB）与整包上限（64 MB / 2000 条）：压缩炸弹防护。
const MAX_ZIP_ENTRY_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 2000;

#[derive(Debug, Serialize)]
pub struct ExtractReport {
    /// 解压出的相对路径（posix 分隔符），供前端做包结构归一化
    pub entries: Vec<String>,
    pub files: usize,
    pub bytes: u64,
    /// 被跳过的项（符号链接等）
    pub skipped: Vec<String>,
}

/// zip slip 防护：把压缩包条目名解析到 `dest` 之内，越界即拒绝（**整包拒绝**，不做部分解压）。
///
/// 拒绝形态：绝对路径（`/x`、`C:\x`、`\\srv\share`）、任何 `..` 组件、空条目名。
pub(crate) fn safe_zip_target(dest: &Path, entry_name: &str) -> Result<PathBuf, String> {
    let name = entry_name.replace('\\', "/");
    if name.trim().is_empty() {
        return Err("压缩包存在空条目名 → 拒绝整包".to_string());
    }
    if name.starts_with('/') {
        return Err(format!("压缩包条目为绝对路径（{entry_name}）→ 拒绝整包（zip slip）"));
    }
    let mut out = PathBuf::from(dest);
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err(format!("压缩包条目含 `..`（{entry_name}）→ 拒绝整包（zip slip）"));
        }
        out.push(part);
    }
    // 双保险：逐组件复检（`Component::ParentDir` / 盘符与 UNC 前缀）再比对前缀
    for comp in out.components() {
        match comp {
            Component::ParentDir => {
                return Err(format!("压缩包条目越出目标目录（{entry_name}）→ 拒绝整包（zip slip）"))
            }
            Component::Prefix(_) if !out.starts_with(dest) => {
                return Err(format!("压缩包条目为绝对路径（{entry_name}）→ 拒绝整包（zip slip）"))
            }
            _ => {}
        }
    }
    if !out.starts_with(dest) {
        return Err(format!("压缩包条目越出目标目录（{entry_name}）→ 拒绝整包（zip slip）"));
    }
    Ok(out)
}

/// 解压主题压缩包到目标目录（§3.1：结构不固定的归一化在前端做，本命令只负责**安全落盘**）。
///
/// - zip slip 防护：任一条目越界 → **整包拒绝**（先全量校验，再落盘，避免半成品）；
/// - 符号链接条目跳过并登记（不跟随）；
/// - 压缩炸弹防护：单条目/整包/条目数上限。
#[tauri::command]
pub async fn extract_zip(zip_path: String, dest_dir: String) -> Result<ExtractReport, String> {
    tauri::async_runtime::spawn_blocking(move || extract_zip_sync(Path::new(&zip_path), Path::new(&dest_dir)))
        .await
        .map_err(|e| format!("解压任务失败: {e}"))?
}

fn extract_zip_sync(zip_path: &Path, dest: &Path) -> Result<ExtractReport, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开压缩包失败: {e}"))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("解析压缩包失败（不是有效的 zip）: {e}"))?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!("压缩包条目数 {} 超过上限 {}", archive.len(), MAX_ZIP_ENTRIES));
    }

    // ① 先全量校验（zip slip + 体积），任何一条不合规就整包拒绝
    struct Planned {
        rel: String,
        target: PathBuf,
        is_dir: bool,
        size: u64,
    }
    let mut planned: Vec<Planned> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("读取压缩包条目失败: {e}"))?;
        let raw_name = entry.name().to_string();
        let rel = raw_name.replace('\\', "/");
        let is_dir = entry.is_dir();
        // 符号链接条目：跳过（不跟随）
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                skipped.push(format!("{}（符号链接，不跟随）", rel));
                continue;
            }
        }
        let target = safe_zip_target(dest, &raw_name)?;
        if !is_dir {
            if entry.size() > MAX_ZIP_ENTRY_BYTES {
                return Err(format!(
                    "压缩包条目 {} 体积 {} 字节超过单条上限 {} 字节",
                    rel,
                    entry.size(),
                    MAX_ZIP_ENTRY_BYTES
                ));
            }
            total += entry.size();
            if total > MAX_ZIP_TOTAL_BYTES {
                return Err(format!("压缩包解压后总体积超过上限 {} 字节", MAX_ZIP_TOTAL_BYTES));
            }
        }
        planned.push(Planned { rel, target, is_dir, size: entry.size() });
    }

    // ② 落盘
    let mut report = ExtractReport { entries: Vec::new(), files: 0, bytes: 0, skipped };
    fs::create_dir_all(dest).map_err(|e| format!("创建目标目录失败: {e}"))?;
    for item in &planned {
        if item.is_dir {
            fs::create_dir_all(&item.target).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            if let Some(parent) = item.target.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
            }
            let mut src = archive
                .by_name(&item.rel)
                .map_err(|e| format!("重新读取条目 {} 失败: {e}", item.rel))?;
            let mut out = fs::File::create(&item.target).map_err(|e| format!("写入失败: {e}"))?;
            io::copy(&mut src, &mut out).map_err(|e| format!("写入失败: {e}"))?;
            report.files += 1;
            report.bytes += item.size;
        }
        report.entries.push(item.rel.clone());
    }
    Ok(report)
}

/// 预装主题源副本目录（§2 新-2：`$RESOURCE/themes`，内含 `manifest.json`）。
/// dev 下 `resource_dir()` 为 `target/debug`（无资源拷贝），回落到仓库 `src-tauri/resources/themes`。
#[tauri::command]
pub fn resource_themes_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let primary = app
        .path()
        .resource_dir()
        .map(|dir| dir.join("themes"))
        .map_err(|e| format!("解析资源目录失败: {e}"))?;
    if primary.is_dir() {
        return Ok(primary.to_string_lossy().into_owned());
    }
    let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources").join("themes");
    if dev.is_dir() {
        return Ok(dev.to_string_lossy().into_owned());
    }
    Ok(primary.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("inkling-themes-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("创建临时目录");
        dir
    }

    #[test]
    fn safe_zip_target_accepts_nested_relative() {
        let dest = Path::new("/tmp/themes");
        let target = safe_zip_target(dest, "vue/vue.css").expect("正常条目应通过");
        assert!(target.starts_with(dest));
        assert!(target.ends_with("vue/vue.css"));
    }

    #[test]
    fn safe_zip_target_rejects_traversal_and_absolute() {
        let dest = Path::new("/tmp/themes");
        // zip slip 的核心负例：`../` 逃逸
        assert!(safe_zip_target(dest, "../evil.css").is_err());
        assert!(safe_zip_target(dest, "vue/../../evil.css").is_err());
        assert!(safe_zip_target(dest, "..\\evil.css").is_err());
        // 绝对路径（POSIX / Windows 盘符 / UNC）
        assert!(safe_zip_target(dest, "/etc/passwd").is_err());
        assert!(safe_zip_target(dest, "C:\\Windows\\evil.css").is_err());
        assert!(safe_zip_target(dest, "\\\\srv\\share\\evil.css").is_err());
        assert!(safe_zip_target(dest, "   ").is_err());
    }

    #[test]
    fn scan_theme_dir_skips_hidden_and_symlinks() {
        let dir = temp_dir("scan");
        fs::write(dir.join("vue.css"), "h1{}").unwrap();
        fs::create_dir_all(dir.join("vue")).unwrap();
        fs::write(dir.join("vue").join("font.woff2"), "xx").unwrap();
        fs::write(dir.join(".hidden.css"), "x").unwrap();
        fs::create_dir_all(dir.join(".backup")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("vue.css"), dir.join("link.css")).unwrap();

        let scan = scan_theme_dir_sync(&dir).expect("扫描成功");
        let names: Vec<_> = scan.entries.iter().map(|e| e.name.clone()).collect();
        assert!(names.contains(&"vue.css".to_string()));
        assert!(names.contains(&"vue".to_string()));
        assert!(!names.contains(&".hidden.css".to_string()));
        assert!(!names.contains(&".backup".to_string()));
        #[cfg(unix)]
        {
            assert!(!names.contains(&"link.css".to_string()));
            assert_eq!(scan.skipped.len(), 1);
        }
        // 目录在前
        assert!(scan.entries[0].is_dir);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_missing_dir_is_not_an_error() {
        let scan = scan_theme_dir_sync(Path::new("/tmp/inkling-definitely-not-exists-307")).unwrap();
        assert!(scan.entries.is_empty());
    }

    #[test]
    fn copy_path_recurses_and_overwrites() {
        let src = temp_dir("copy-src");
        let dest = temp_dir("copy-dest");
        fs::create_dir_all(src.join("vue")).unwrap();
        fs::write(src.join("vue.css"), "a{}").unwrap();
        fs::write(src.join("vue").join("f.woff2"), "font").unwrap();

        let report = copy_path_sync(&src, &dest.join("themes")).expect("复制成功");
        assert_eq!(report.files, 2);
        assert!(dest.join("themes").join("vue.css").is_file());
        assert!(dest.join("themes").join("vue").join("f.woff2").is_file());

        // 覆盖语义：再次复制同名文件（内容更新）
        fs::write(src.join("vue.css"), "b{}").unwrap();
        copy_path_sync(&src.join("vue.css"), &dest.join("themes").join("vue.css")).unwrap();
        assert_eq!(fs::read_to_string(dest.join("themes").join("vue.css")).unwrap(), "b{}");
        let _ = fs::remove_dir_all(&src);
        let _ = fs::remove_dir_all(&dest);
    }

    #[test]
    fn extract_zip_rejects_zip_slip_and_writes_safe_entries() {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let dir = temp_dir("zip");
        let zip_path = dir.join("theme.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            writer.start_file("vue.css", opts).unwrap();
            writer.write_all(b"h1{color:#333}").unwrap();
            writer.add_directory("vue/", opts).unwrap();
            writer.start_file("vue/font.woff2", opts).unwrap();
            writer.write_all(b"font").unwrap();
            // 恶意条目：zip slip
            writer.start_file("../evil.css", opts).unwrap();
            writer.write_all(b"pwned").unwrap();
            writer.finish().unwrap();
        }

        let dest = dir.join("out");
        let err = extract_zip_sync(&zip_path, &dest).expect_err("zip slip 必须整包拒绝");
        assert!(err.contains("zip slip"), "错误信息应点明 zip slip：{err}");
        // 整包拒绝 → 不留半成品
        assert!(!dest.join("vue.css").exists());

        // 合法包：正常解压
        let ok_zip = dir.join("ok.zip");
        {
            let file = fs::File::create(&ok_zip).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            let opts = SimpleFileOptions::default();
            writer.start_file("vue.css", opts).unwrap();
            writer.write_all(b"h1{color:#333}").unwrap();
            writer.add_directory("vue/", opts).unwrap();
            writer.start_file("vue/font.woff2", opts).unwrap();
            writer.write_all(b"font").unwrap();
            writer.finish().unwrap();
        }
        let dest2 = dir.join("out2");
        let report = extract_zip_sync(&ok_zip, &dest2).expect("合法包应解压成功");
        assert_eq!(report.files, 2);
        assert!(dest2.join("vue.css").is_file());
        assert!(dest2.join("vue").join("font.woff2").is_file());
        assert!(report.entries.iter().any(|e| e == "vue.css"));
        let _ = fs::remove_dir_all(&dir);
    }
}
