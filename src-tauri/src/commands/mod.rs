// 文件系统相关命令
// 所有文件系统操作集中在这里，前端通过 invoke 调用，不允许前端直接拼路径操作 fs

pub mod pandoc;
pub use pandoc::{pandoc_check, pandoc_export_docx};

pub mod search;
pub use search::search_in_workspace;

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static TEMP_WRITE_SEQ: AtomicU64 = AtomicU64::new(0);

fn generate_atomic_temp_path(parent: &Path, file_name: &str) -> std::path::PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = TEMP_WRITE_SEQ.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    parent.join(format!(".{}.tmp.{}-{}-{}", file_name, pid, nonce, seq))
}

/// Windows 回退替换：常规 `fs::rename` 失败时短暂退避重试原子替换。
///
/// 关键约束（issue #146）：**任何失败路径都不得先删除用户原件**。
/// 旧实现在回退分支「先 remove_file 目标再 rename」，两步之间若崩溃/断电，
/// 原文件已删而新内容未就位，造成用户文档丢失；现改为只做原子替换重试，
/// 全部重试失败则保留原件并返回错误（临时文件由调用方清理）。
#[cfg(windows)]
fn replace_file_with_retry(temp_path: &Path, path: &Path) -> std::io::Result<()> {
    const MAX_RETRIES: u32 = 4;
    const RETRY_DELAY_MS: u64 = 50;

    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            // 短暂退避应对杀毒软件/索引器对目标文件的瞬时占用
            std::thread::sleep(std::time::Duration::from_millis(RETRY_DELAY_MS));
        }
        match fs::rename(temp_path, path) {
            Ok(()) => return Ok(()),
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("替换目标文件失败")))
}

const IGNORED_DIR_NAMES: &[&str] = &["node_modules", "target", "dist", "build", "out"];

/// 文件树节点
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    /// 显示名（文件/目录名）
    pub name: String,
    /// 完整路径
    pub path: String,
    /// 是否目录
    pub is_dir: bool,
    /// 子节点（仅目录有）
    #[serde(default)]
    pub children: Vec<FileNode>,
}

/// 列出目录的直接子项
/// - 文件系统操作在线程池执行，避免阻塞 Tauri 异步运行时
/// - 跳过隐藏项、常见依赖/构建目录和目录符号链接
/// - 仅返回目录和 Markdown 文件，目录在前并按名称排序
///
/// `max_depth` 仅为兼容旧版前端调用保留；目录树现在由前端按需逐层加载
#[tauri::command]
pub async fn list_dir(dir_path: String, max_depth: Option<usize>) -> Result<FileNode, String> {
    let _ = max_depth;
    tauri::async_runtime::spawn_blocking(move || list_dir_shallow(Path::new(&dir_path)))
        .await
        .map_err(|e| format!("目录扫描任务失败: {e}"))?
}

fn list_dir_shallow(path: &Path) -> Result<FileNode, String> {
    if !path.exists() {
        return Err(format!("路径不存在: {}", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("不是目录: {}", path.display()));
    }

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let mut node = FileNode {
        name,
        path: path.to_string_lossy().into_owned(),
        is_dir: true,
        children: Vec::new(),
    };

    // 排序键在收集条目时只计算一次，避免比较器反复分配 lowercase 字符串
    let mut dirs: Vec<(String, FileNode)> = Vec::new();
    let mut files: Vec<(String, FileNode)> = Vec::new();
    let entries =
        fs::read_dir(path).map_err(|e| format!("读取目录失败 {}: {e}", path.display()))?;

    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                eprintln!("skip entry in {}: {e}", path.display());
                continue;
            }
        };
        let entry_name = entry.file_name().to_string_lossy().into_owned();
        if entry_name.starts_with('.') {
            continue;
        }

        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(e) => {
                eprintln!("skip {}: {e}", entry.path().display());
                continue;
            }
        };
        // DirEntry::file_type 不跟随链接；目录链接必须跳过，普通文件链接仍可打开
        let (is_dir, is_file) = if file_type.is_symlink() {
            match fs::metadata(entry.path()) {
                Ok(metadata) if metadata.is_dir() => continue,
                Ok(metadata) => (false, metadata.is_file()),
                Err(e) => {
                    eprintln!("skip {}: {e}", entry.path().display());
                    continue;
                }
            }
        } else {
            (file_type.is_dir(), file_type.is_file())
        };
        if is_dir && is_ignored_dir(&entry_name) {
            continue;
        }
        if !is_dir && (!is_file || !is_markdown_file(&entry.path())) {
            continue;
        }

        let child = FileNode {
            name: entry_name.clone(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
            children: Vec::new(),
        };
        let sortable = (entry_name.to_lowercase(), child);
        if is_dir {
            dirs.push(sortable);
        } else {
            files.push(sortable);
        }
    }

    let compare = |a: &(String, FileNode), b: &(String, FileNode)| {
        a.0.cmp(&b.0).then_with(|| a.1.name.cmp(&b.1.name))
    };
    dirs.sort_by(compare);
    files.sort_by(compare);
    node.children = dirs.into_iter().map(|(_, child)| child).collect();
    node.children
        .extend(files.into_iter().map(|(_, child)| child));

    Ok(node)
}

fn is_ignored_dir(name: &str) -> bool {
    IGNORED_DIR_NAMES
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("markdown")
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after Unix epoch")
                .as_nanos();
            let sequence = NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "inklingmd-list-dir-{label}-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test directory");
            Self { path }
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn touch(path: &Path) {
        fs::write(path, "").expect("create test file");
    }

    #[test]
    fn lists_only_direct_children() {
        let temp = TestDir::new("shallow");
        let nested = temp.path.join("nested");
        fs::create_dir(&nested).unwrap();
        touch(&temp.path.join("root.md"));
        touch(&nested.join("deep.md"));

        let root = list_dir_shallow(&temp.path).unwrap();

        assert!(root.is_dir);
        assert_eq!(root.children.len(), 2);
        assert_eq!(root.children[0].name, "nested");
        assert!(root.children[0].is_dir);
        assert!(root.children[0].children.is_empty());
        assert_eq!(root.children[1].name, "root.md");
        assert!(!root.children[1].is_dir);
    }

    #[test]
    fn sorts_directories_before_files_case_insensitively() {
        let temp = TestDir::new("sorting");
        fs::create_dir(temp.path.join("zebra")).unwrap();
        fs::create_dir(temp.path.join("Alpha")).unwrap();
        touch(&temp.path.join("Zeta.md"));
        touch(&temp.path.join("beta.MD"));
        touch(&temp.path.join("alpha.markdown"));

        let root = list_dir_shallow(&temp.path).unwrap();
        let names: Vec<_> = root
            .children
            .iter()
            .map(|child| child.name.as_str())
            .collect();

        assert_eq!(
            names,
            ["Alpha", "zebra", "alpha.markdown", "beta.MD", "Zeta.md"]
        );
    }

    #[test]
    fn filters_hidden_build_and_non_markdown_entries() {
        let temp = TestDir::new("filtering");
        for name in [".git", "node_modules", "target", "dist", "build", "out"] {
            fs::create_dir(temp.path.join(name)).unwrap();
        }
        fs::create_dir(temp.path.join("notes")).unwrap();
        touch(&temp.path.join(".hidden.md"));
        touch(&temp.path.join("draft.txt"));
        touch(&temp.path.join("draft.md.bak"));
        touch(&temp.path.join("README.md"));
        touch(&temp.path.join("guide.markdown"));
        for index in 0..2_000 {
            touch(&temp.path.join(format!("unrelated-{index}.txt")));
        }

        let root = list_dir_shallow(&temp.path).unwrap();
        let names: Vec<_> = root
            .children
            .iter()
            .map(|child| child.name.as_str())
            .collect();

        assert_eq!(names, ["notes", "guide.markdown", "README.md"]);
    }

    #[test]
    fn rejects_missing_and_non_directory_paths() {
        let temp = TestDir::new("invalid");
        let file_path = temp.path.join("note.md");
        touch(&file_path);

        let missing = list_dir_shallow(&temp.path.join("missing")).unwrap_err();
        let not_directory = list_dir_shallow(&file_path).unwrap_err();

        assert!(missing.contains("路径不存在"));
        assert!(not_directory.contains("不是目录"));
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_directory_symlinks() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new("symlink");
        let target = TestDir::new("symlink-target");
        let real_dir = temp.path.join("real");
        fs::create_dir(&real_dir).unwrap();
        touch(&real_dir.join("inside.md"));
        let target_file = target.path.join("source.md");
        touch(&target_file);
        symlink(&real_dir, temp.path.join("linked")).unwrap();
        symlink(&temp.path, temp.path.join("loop")).unwrap();
        symlink(&target_file, temp.path.join("linked.md")).unwrap();

        let root = list_dir_shallow(&temp.path).unwrap();
        let names: Vec<_> = root
            .children
            .iter()
            .map(|child| child.name.as_str())
            .collect();

        assert_eq!(names, ["real", "linked.md"]);
        assert!(root.children[0].children.is_empty());
        assert!(!root.children[1].is_dir);
    }

    #[cfg(windows)]
    #[test]
    fn does_not_follow_directory_symlinks() {
        use std::process::Command;

        let temp = TestDir::new("symlink");
        let real_dir = temp.path.join("real");
        fs::create_dir(&real_dir).unwrap();
        touch(&real_dir.join("inside.md"));
        touch(&temp.path.join("visible.md"));
        for (link, target) in [
            (temp.path.join("linked"), real_dir),
            (temp.path.join("loop"), temp.path.clone()),
        ] {
            let output = Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .expect("cmd.exe should create a directory junction");
            assert!(
                output.status.success(),
                "failed to create junction: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        let root = list_dir_shallow(&temp.path).unwrap();
        let names: Vec<_> = root.children.iter().map(|child| child.name.as_str()).collect();
        assert_eq!(names, ["real", "visible.md"]);
    }

    #[test]
    fn test_file_operations_crud() {
        let temp = TestDir::new("file_ops");
        let test_file = temp.path.join("nested/folder/test.md");
        let test_file_str = test_file.to_string_lossy().to_string();

        // 1. 测试 create_file 自动创建父目录
        create_file_sync(test_file_str.clone()).unwrap();
        assert!(test_file.exists());
        assert_eq!(read_text_file_sync(test_file_str.clone()).unwrap(), "");

        // 2. 测试 create_file 重复创建报错
        assert!(create_file_sync(test_file_str.clone()).is_err());

        // 3. 测试 write_text_file 覆盖写入
        write_text_file_sync(test_file_str.clone(), "# Hello World\nLine 2".into()).unwrap();
        assert_eq!(
            read_text_file_sync(test_file_str.clone()).unwrap(),
            "# Hello World\nLine 2"
        );

        // 4. 测试 file_mtime 获取毫秒时间戳
        let mtime = file_mtime_sync(test_file_str.clone()).unwrap();
        // 毫秒时间戳应该远大于 1,700,000,000,000 (2023年)
        assert!(mtime > 1_700_000_000_000.0);

        // 5. 测试 write_binary_file
        let bin_file = temp.path.join("nested/folder/image.png");
        let bin_file_str = bin_file.to_string_lossy().to_string();
        let bin_data = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        let bin_data_base64 =
            base64::engine::general_purpose::STANDARD.encode(&bin_data);
        write_binary_file_sync(bin_file_str.clone(), bin_data_base64).unwrap();
        let read_bin = fs::read(&bin_file).unwrap();
        assert_eq!(read_bin, bin_data);

        // 6. 测试 rename_path
        let renamed_file = temp.path.join("nested/folder/renamed.md");
        let renamed_str = renamed_file.to_string_lossy().to_string();
        rename_path_sync(test_file_str.clone(), renamed_str.clone()).unwrap();
        assert!(!test_file.exists());
        assert!(renamed_file.exists());
        assert_eq!(
            read_text_file_sync(renamed_str.clone()).unwrap(),
            "# Hello World\nLine 2"
        );

        // 7. 测试 delete_path (文件和目录)
        delete_path_sync(renamed_str).unwrap();
        assert!(!renamed_file.exists());

        let nested_dir = temp.path.join("nested");
        assert!(nested_dir.exists());
        delete_path_sync(nested_dir.to_string_lossy().to_string()).unwrap();
        assert!(!nested_dir.exists());
    }

    #[test]
    fn test_create_dir_and_errors() {
        let temp = TestDir::new("create_dir");
        let dir = temp.path.join("a/b/c");
        let dir_str = dir.to_string_lossy().to_string();

        create_dir_sync(dir_str.clone()).unwrap();
        assert!(dir.is_dir());

        // 重复创建应报错
        let err = create_dir_sync(dir_str).unwrap_err();
        assert!(err.contains("目录已存在"));

        // 读取不存在文件应报错
        let not_found_err =
            read_text_file_sync(temp.path.join("nonexistent.md").to_string_lossy().to_string())
                .unwrap_err();
        assert!(not_found_err.contains("文件不存在"));

        // 获取不存在文件 mtime 应报错
        let mtime_err =
            file_mtime_sync(temp.path.join("nonexistent.md").to_string_lossy().to_string()).unwrap_err();
        assert!(mtime_err.contains("文件不存在"));
    }

    #[test]
    fn rename_rejects_an_existing_target_without_overwriting_it() {
        let temp = TestDir::new("rename-existing");
        let source = temp.path.join("source.md");
        let target = temp.path.join("target.md");
        fs::write(&source, "source").unwrap();
        fs::write(&target, "target").unwrap();

        let error = rename_path_sync(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert!(error.contains("目标已存在"));
        assert_eq!(fs::read_to_string(&source).unwrap(), "source");
        assert_eq!(fs::read_to_string(&target).unwrap(), "target");
    }

    // ===== issue #159：编码与大小护栏 =====

    #[test]
    fn read_reports_encoding_marker_for_non_utf8() {
        let temp = TestDir::new("read-encoding");
        let gbk_file = temp.path.join("gbk.md");
        // GBK 编码的「你好」字节序列，非合法 UTF-8
        fs::write(&gbk_file, [0xC4, 0xE3, 0xBA, 0xC3]).unwrap();

        let error = read_text_file_sync(gbk_file.to_string_lossy().into_owned()).unwrap_err();
        // 结构化标记供前端映射；不再透传 "stream did not contain valid UTF-8"
        assert!(error.contains(READ_ERROR_ENCODING_UNSUPPORTED));
        assert!(!error.contains("stream did not contain valid UTF-8"));
    }

    #[test]
    fn read_rejects_files_above_size_limit_but_accepts_the_limit() {
        let temp = TestDir::new("read-size");

        let oversized = temp.path.join("oversized.md");
        fs::write(&oversized, vec![b'a'; MAX_READ_SIZE as usize + 1]).unwrap();
        let error = read_text_file_sync(oversized.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains(READ_ERROR_FILE_TOO_LARGE));

        // 恰好等于上限仍可打开（护栏只拦超限）
        let at_limit = temp.path.join("at-limit.md");
        fs::write(&at_limit, vec![b'a'; MAX_READ_SIZE as usize]).unwrap();
        let content = read_text_file_sync(at_limit.to_string_lossy().into_owned()).unwrap();
        assert_eq!(content.len(), MAX_READ_SIZE as usize);
    }

    // ===== issue #161：跨盘移动与原子占用 =====

    #[test]
    fn rename_moves_directory_with_contents_same_volume() {
        let temp = TestDir::new("rename-dir");
        let source_dir = temp.path.join("docs");
        fs::create_dir_all(source_dir.join("sub")).unwrap();
        fs::write(source_dir.join("a.md"), "alpha").unwrap();
        fs::write(source_dir.join("sub/b.md"), "beta").unwrap();

        let target_dir = temp.path.join("renamed-docs");
        rename_path_sync(
            source_dir.to_string_lossy().into_owned(),
            target_dir.to_string_lossy().into_owned(),
        )
        .unwrap();

        assert!(!source_dir.exists());
        assert_eq!(fs::read_to_string(target_dir.join("a.md")).unwrap(), "alpha");
        assert_eq!(fs::read_to_string(target_dir.join("sub/b.md")).unwrap(), "beta");
    }

    #[test]
    fn cross_device_detection_matches_platform_errors() {
        #[cfg(windows)]
        let cross = io::Error::from_raw_os_error(17); // ERROR_NOT_SAME_DEVICE
        #[cfg(unix)]
        let cross = io::Error::from_raw_os_error(18); // EXDEV
        assert!(is_cross_device_error(&cross));

        let not_cross = io::Error::from_raw_os_error(
            #[cfg(windows)]
            5, // ERROR_ACCESS_DENIED
            #[cfg(unix)]
            13, // EACCES
        );
        assert!(!is_cross_device_error(&not_cross));
    }

    #[test]
    fn move_cross_device_moves_file_and_removes_source() {
        let temp = TestDir::new("cross-file");
        let source = temp.path.join("from.md");
        let target = temp.path.join("to.md");
        fs::write(&source, "跨盘内容").unwrap();

        move_cross_device(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read_to_string(&target).unwrap(), "跨盘内容");
    }

    #[test]
    fn move_cross_device_moves_directory_recursively() {
        let temp = TestDir::new("cross-dir");
        let source = temp.path.join("from-dir");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("top.md"), "top").unwrap();
        fs::write(source.join("nested/deep.md"), "deep").unwrap();
        let target = temp.path.join("to-dir");

        move_cross_device(&source, &target).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read_to_string(target.join("top.md")).unwrap(), "top");
        assert_eq!(fs::read_to_string(target.join("nested/deep.md")).unwrap(), "deep");
    }

    #[test]
    fn move_cross_device_failure_keeps_source_intact() {
        let temp = TestDir::new("cross-fail");
        let source = temp.path.join("from.md");
        fs::write(&source, "原件").unwrap();
        // 目标父目录不存在 → 复制必然失败
        let target = temp.path.join("missing-parent/to.md");

        let error = move_cross_device(&source, &target).unwrap_err();
        assert!(error.contains("跨盘复制失败"));
        // 核心保证：失败后源原件完整保留，不产生半成品目标
        assert_eq!(fs::read_to_string(&source).unwrap(), "原件");
        assert!(!target.exists());
    }

    #[test]
    fn delete_reports_a_missing_path_instead_of_succeeding() {
        let temp = TestDir::new("delete-missing");
        let missing = temp.path.join("missing.md");
        let error = delete_path_sync(missing.to_string_lossy().into_owned()).unwrap_err();
        assert!(error.contains("路径不存在"));
    }

    #[test]
    fn delete_preserves_permission_denied_context() {
        let temp = TestDir::new("delete-permission");
        let file = temp.path.join("protected.md");
        touch(&file);

        let error = delete_path_with(
            &file,
            |_| {
                Err(std::io::Error::new(
                    std::io::ErrorKind::PermissionDenied,
                    "access denied by test filesystem",
                ))
            },
            |_| Ok(()),
        )
        .unwrap_err();

        assert!(error.contains("删除文件失败"));
        assert!(error.contains("access denied by test filesystem"));
        assert!(file.exists(), "failed deletion must leave the source intact");
    }

    #[test]
    fn test_atomic_write_safety() {
        let temp = TestDir::new("atomic_write");
        let file = temp.path.join("doc.md");
        let file_str = file.to_string_lossy().to_string();

        write_text_file_sync(file_str.clone(), "Initial content".into()).unwrap();
        assert_eq!(read_text_file_sync(file_str.clone()).unwrap(), "Initial content");

        // 覆盖写入
        write_text_file_sync(file_str.clone(), "Updated content".into()).unwrap();
        assert_eq!(read_text_file_sync(file_str.clone()).unwrap(), "Updated content");

        // 二进制原子写入测试（含父目录自动创建、覆盖与临时文件不残留）
        let bin_file = temp.path.join("deep/sub/dir/image.bin");
        let bin_file_str = bin_file.to_string_lossy().to_string();
        let bin_data = vec![0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0];
        let bin_base64 = base64::engine::general_purpose::STANDARD.encode(&bin_data);
        write_binary_file_sync(bin_file_str.clone(), bin_base64).unwrap();
        assert_eq!(fs::read(&bin_file).unwrap(), bin_data);

        // 覆盖二进制文件
        let bin_data_updated = vec![0xfe, 0xdc, 0xba, 0x98];
        let bin_base64_updated =
            base64::engine::general_purpose::STANDARD.encode(&bin_data_updated);
        write_binary_file_sync(bin_file_str.clone(), bin_base64_updated).unwrap();
        assert_eq!(fs::read(&bin_file).unwrap(), bin_data_updated);

        // 验证没有残留的 .tmp 临时文件
        let deep_dir = temp.path.join("deep/sub/dir");
        let entries = fs::read_dir(&deep_dir).unwrap();
        for entry in entries {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().to_string();
            assert!(!name.starts_with('.'), "不应存在残留临时文件: {name}");
        }

        // 写入非法 base64 应失败且不触碰/创建无效文件
        let invalid_file = temp.path.join("deep/sub/dir/invalid.bin");
        let invalid_file_str = invalid_file.to_string_lossy().to_string();
        let err = write_binary_file_sync(invalid_file_str, "not-valid-base64!@#$".into()).unwrap_err();
        assert!(err.contains("Base64 解码失败"));
        assert!(!invalid_file.exists());
    }

    // ===== issue #146：Windows 写入回退必须保留用户原件 =====

    #[cfg(windows)]
    #[test]
    fn replace_with_retry_replaces_target_when_unlocked() {
        let temp = TestDir::new("replace-ok");
        let target = temp.path.join("note.md");
        fs::write(&target, "original").unwrap();
        let staged = temp.path.join("staged.md");
        fs::write(&staged, "new content").unwrap();

        replace_file_with_retry(&staged, &target).unwrap();

        assert_eq!(fs::read_to_string(&target).unwrap(), "new content");
        assert!(!staged.exists(), "替换成功后临时文件应已被移动走");
    }

    #[cfg(windows)]
    #[test]
    fn replace_with_retry_preserves_original_when_target_locked() {
        use std::os::windows::fs::OpenOptionsExt;

        let temp = TestDir::new("replace-locked");
        let target = temp.path.join("note.md");
        fs::write(&target, "original").unwrap();
        let staged = temp.path.join("staged.md");
        fs::write(&staged, "new content").unwrap();

        // 以 share_mode(0) 独占打开目标文件，模拟杀毒软件/索引器瞬时占用：
        // rename 替换必然失败，回退重试也应失败。
        // 注意：独占句柄同时阻止其他句柄读取，因此只覆盖替换调用本身
        let err = {
            let _guard = fs::OpenOptions::new()
                .write(true)
                .share_mode(0)
                .open(&target)
                .expect("以独占模式打开目标文件");

            replace_file_with_retry(&staged, &target)
                .expect_err("目标被独占占用时替换应当失败")
        };

        // 核心保证：替换失败后用户原件必须原样保留
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "original",
            "替换失败后不得损坏/丢失用户原件"
        );
        // 新内容仍留在临时文件中，等待下次写入重试
        assert_eq!(fs::read_to_string(&staged).unwrap(), "new content");
        assert!(!err.to_string().is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn replace_with_retry_preserves_original_when_temp_missing() {
        let temp = TestDir::new("replace-no-temp");
        let target = temp.path.join("note.md");
        fs::write(&target, "original").unwrap();
        let staged = temp.path.join("missing.md");

        // 临时文件不存在（如写中途被清理）：重试必然失败，但原件不得被触碰
        let err = replace_file_with_retry(&staged, &target)
            .expect_err("临时文件缺失时替换应当失败");
        assert!(err.to_string().contains("系统找不到指定的文件") || !err.to_string().is_empty());

        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "original",
            "失败路径不得损坏用户原件"
        );
    }
}

/// 写入文本文件（原子写入：写入临时文件再重命名，避免写盘崩溃导致截断损坏）
#[tauri::command]
pub async fn write_text_file(file_path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_text_file_sync(file_path, content))
        .await
        .map_err(|e| format!("文件写入任务失败: {e}"))?
}

fn write_text_file_sync(file_path: String, content: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let temp_path = generate_atomic_temp_path(parent, &file_name);

    let mut temp_file = fs::File::create(&temp_path)
        .map_err(|e| format!("创建临时文件失败 {}: {}", temp_path.display(), e))?;
    if let Err(e) = temp_file.write_all(content.as_bytes()) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("写入临时文件失败 {}: {}", temp_path.display(), e));
    }
    if let Err(e) = temp_file.sync_all() {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("临时文件物理落盘(sync_all)失败 {}: {}", temp_path.display(), e));
    }
    drop(temp_file);

    // 重命名原子替换目标文件
    if let Err(e) = fs::rename(&temp_path, path) {
        // Windows 上如果目标已存在，短暂退避重试原子替换（issue #146：
        // 绝不先删除用户原件再替换，避免两步之间崩溃导致文档丢失）
        #[cfg(windows)]
        {
            if path.exists() {
                if let Err(e2) = replace_file_with_retry(&temp_path, path) {
                    let _ = fs::remove_file(&temp_path);
                    return Err(format!(
                        "替换目标文件失败 {}（已保留原文件）: {}",
                        file_path, e2
                    ));
                }
                return Ok(());
            }
        }
        let _ = fs::remove_file(&temp_path);
        return Err(format!("替换目标文件失败 {}: {}", file_path, e));
    }

    Ok(())
}

/// 写入二进制文件（图片等，原子写入：Base64 解码后写入临时文件再重命名，避免截断损坏和 IPC 膨胀）
#[tauri::command]
pub async fn write_binary_file(file_path: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_binary_file_sync(file_path, data))
        .await
        .map_err(|e| format!("二进制写入任务失败: {e}"))?
}

fn write_binary_file_sync(file_path: String, data_base64: String) -> Result<(), String> {
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("Base64 解码失败: {e}"))?;

    let path = Path::new(&file_path);
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy())
        .unwrap_or_default();
    let temp_path = generate_atomic_temp_path(parent, &file_name);

    let mut temp_file = fs::File::create(&temp_path)
        .map_err(|e| format!("创建临时文件失败 {}: {}", temp_path.display(), e))?;
    if let Err(e) = temp_file.write_all(&decoded) {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("写入临时文件失败 {}: {}", temp_path.display(), e));
    }
    if let Err(e) = temp_file.sync_all() {
        let _ = fs::remove_file(&temp_path);
        return Err(format!("临时文件物理落盘(sync_all)失败 {}: {}", temp_path.display(), e));
    }
    drop(temp_file);

    // 重命名原子替换目标文件
    if let Err(e) = fs::rename(&temp_path, path) {
        // Windows 上如果目标已存在，短暂退避重试原子替换（issue #146：
        // 绝不先删除用户原件再替换，避免两步之间崩溃导致数据丢失）
        #[cfg(windows)]
        {
            if path.exists() {
                if let Err(e2) = replace_file_with_retry(&temp_path, path) {
                    let _ = fs::remove_file(&temp_path);
                    return Err(format!(
                        "替换目标文件失败 {}（已保留原文件）: {}",
                        file_path, e2
                    ));
                }
                return Ok(());
            }
        }
        let _ = fs::remove_file(&temp_path);
        return Err(format!("替换目标文件失败 {}: {}", file_path, e));
    }

    Ok(())
}

/// 读取文本文件内容（UTF-8）
#[tauri::command]
pub async fn read_text_file(file_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || read_text_file_sync(file_path))
        .await
        .map_err(|e| format!("文件读取任务失败: {e}"))?
}

/// issue #159：文本读取大小上限——防止数百 MB 文件整体读入内存并经 JSON IPC 传输。
/// 打开场景比搜索侧（5MB）放宽到 10MB，仍可挡住病态大文件。
const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// issue #159：非 UTF-8 结构化错误标记（前端按此映射为可读提示，契约见前端 fs.ts）
pub const READ_ERROR_ENCODING_UNSUPPORTED: &str = "ENCODING_UNSUPPORTED";
/// issue #159：文件过大结构化错误标记
pub const READ_ERROR_FILE_TOO_LARGE: &str = "FILE_TOO_LARGE";

fn read_text_file_sync(file_path: String) -> Result<String, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }
    // issue #159：大小护栏，先用元数据判断，避免超大文件整体进内存
    if let Ok(meta) = fs::metadata(path) {
        if meta.len() > MAX_READ_SIZE {
            return Err(format!(
                "{}: 文件过大（{:.1} MB，超过 {} MB 打开上限），无法打开",
                READ_ERROR_FILE_TOO_LARGE,
                meta.len() as f64 / (1024.0 * 1024.0),
                MAX_READ_SIZE / (1024 * 1024),
            ));
        }
    }
    // issue #159：非 UTF-8（GBK/Big5 等）返回结构化标记，
    // 不再把 "stream did not contain valid UTF-8" 英文错误直接透传给用户
    let bytes = fs::read(path).map_err(|e| format!("读取失败 {}: {}", file_path, e))?;
    String::from_utf8(bytes).map_err(|_| {
        format!(
            "{}: 文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），无法打开",
            READ_ERROR_ENCODING_UNSUPPORTED
        )
    })
}

/// 读取文件的最后修改时间（Unix 毫秒，浮点）
/// 用于前端轮询检测外部修改，提示用户重新加载
#[tauri::command]
pub async fn file_mtime(file_path: String) -> Result<f64, String> {
    tauri::async_runtime::spawn_blocking(move || file_mtime_sync(file_path))
        .await
        .map_err(|e| format!("获取文件修改时间任务失败: {e}"))?
}

fn file_mtime_sync(file_path: String) -> Result<f64, String> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("文件不存在: {}", file_path));
    }
    let meta = fs::metadata(path).map_err(|e| format!("读取元数据失败: {}", e))?;
    let mtime = meta
        .modified()
        .map_err(|e| format!("读取修改时间失败: {}", e))?;
    let millis = mtime
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .map_err(|e| e.to_string())?;
    Ok(millis)
}

/// 重命名/移动文件或目录
#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || rename_path_sync(from, to))
        .await
        .map_err(|e| format!("重命名任务失败: {e}"))?
}

fn rename_path_sync(from: String, to: String) -> Result<(), String> {
    let from_path = Path::new(&from);
    let to_path = Path::new(&to);
    if !from_path.exists() {
        return Err(format!("源路径不存在: {}", from));
    }
    if to_path.exists() {
        return Err(format!("目标已存在: {}", to));
    }

    // issue #161：文件移动优先用「硬链接 + 删源」原子占用目标名——
    // 目标已存在时硬链接以 AlreadyExists 原子失败，闭合 exists() 检查与
    // 替换式 fs::rename 之间「目标被并发创建后静默覆盖」的 TOCTOU 窗口。
    // 硬链接跨卷/部分文件系统不可用，失败则落到下方通用移动流程。
    if from_path.is_file() {
        match fs::hard_link(from_path, to_path) {
            Ok(()) => {
                // 目标已就位；即使删源失败数据也同时存在于两处，不丢数据
                return fs::remove_file(from_path)
                    .map_err(|e| format!("移动失败（目标已就位但源文件删除失败）: {e}"));
            }
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                return Err(format!("目标已存在: {}", to));
            }
            Err(_) => { /* 跨卷或不支持硬链接：继续走下方流程 */ }
        }
    }

    match fs::rename(from_path, to_path) {
        Ok(()) => Ok(()),
        // issue #161：跨卷移动回退为复制+删除，不再把裸 OS 错误
        // （Windows ERROR_NOT_SAME_DEVICE）抛给用户
        Err(e) if is_cross_device_error(&e) => move_cross_device(from_path, to_path),
        Err(e) => Err(format!("重命名失败: {e}")),
    }
}

/// issue #161：判定跨卷移动失败（Windows ERROR_NOT_SAME_DEVICE = 17，Unix EXDEV = 18）
fn is_cross_device_error(e: &io::Error) -> bool {
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17)
    }
    #[cfg(unix)]
    {
        e.raw_os_error() == Some(18)
    }
}

/// issue #161：跨卷移动回退——复制 + 删除源。
/// 复制失败时源原件保持完整（不丢数据）；文件复制半途失败会留下残块，
/// 尽力清理（此时目标内容已被失败复制污染，清理是安全且必要的）。
fn move_cross_device(from: &Path, to: &Path) -> Result<(), String> {
    let copy_result = if from.is_dir() {
        copy_dir_recursive(from, to)
    } else {
        fs::copy(from, to)
            .map(|_| ())
            .map_err(|e| format!("跨盘复制失败: {e}"))
    };
    if let Err(e) = copy_result {
        // 仅清理文件残块；目录残块结构不确定，交由用户判断（源原件完整）
        if to.is_file() {
            let _ = fs::remove_file(to);
        }
        return Err(e);
    }
    if from.is_dir() {
        fs::remove_dir_all(from)
            .map_err(|e| format!("跨盘移动：目标已复制完成但源目录删除失败: {e}"))
    } else {
        fs::remove_file(from)
            .map_err(|e| format!("跨盘移动：目标已复制完成但源文件删除失败: {e}"))
    }
}

/// 递归复制目录（std 无目录级 copy），任一项失败即返回错误
fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir(to).map_err(|e| format!("创建目标目录失败: {e}"))?;
    for entry in fs::read_dir(from).map_err(|e| format!("读取源目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取目录项失败: {e}"))?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_dir_recursive(&src, &dst)?;
        } else {
            fs::copy(&src, &dst)
                .map_err(|e| format!("跨盘复制失败 {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// 删除文件或目录（目录时递归删除）
#[tauri::command]
pub async fn delete_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_path_sync(path))
        .await
        .map_err(|e| format!("删除任务失败: {e}"))?
}

fn delete_path_sync(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    delete_path_with(p, |path| fs::remove_file(path), |path| fs::remove_dir_all(path))
}

fn delete_path_with<RemoveFile, RemoveDir>(
    p: &Path,
    remove_file: RemoveFile,
    remove_dir_all: RemoveDir,
) -> Result<(), String>
where
    RemoveFile: FnOnce(&Path) -> std::io::Result<()>,
    RemoveDir: FnOnce(&Path) -> std::io::Result<()>,
{
    if !p.exists() {
        return Err(format!("路径不存在: {}", p.display()));
    }
    if p.is_dir() {
        remove_dir_all(p).map_err(|e| format!("删除目录失败: {}", e))
    } else {
        remove_file(p).map_err(|e| format!("删除文件失败: {}", e))
    }
}

/// 创建空文件（如果父目录不存在则创建）
#[tauri::command]
pub async fn create_file(file_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_file_sync(file_path))
        .await
        .map_err(|e| format!("创建文件任务失败: {e}"))?
}

fn create_file_sync(file_path: String) -> Result<(), String> {
    let path = Path::new(&file_path);
    if path.exists() {
        return Err(format!("文件已存在: {}", file_path));
    }
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
        }
    }
    fs::write(path, "").map_err(|e| format!("创建文件失败: {}", e))
}

/// 创建目录（含父目录）
#[tauri::command]
pub async fn create_dir(dir_path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_dir_sync(dir_path))
        .await
        .map_err(|e| format!("创建目录任务失败: {e}"))?
}

fn create_dir_sync(dir_path: String) -> Result<(), String> {
    let path = Path::new(&dir_path);
    if path.exists() {
        return Err(format!("目录已存在: {}", dir_path));
    }
    fs::create_dir_all(path).map_err(|e| format!("创建目录失败: {}", e))
}

/// 把目录加入 asset 协议运行时白名单（递归）
/// tauri.conf.json 的静态 scope 只覆盖用户目录；工作区/文档位于其他磁盘分区
/// （如 Windows 的 E:\code\...）时，图片经 convertFileSrc 加载会被 asset 协议拒绝。
/// 前端在解析图片路径时对文档所在目录调用本命令动态放行，仅放行用户实际打开的目录。
#[tauri::command]
pub fn allow_asset_dir(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri::Manager;
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("不是目录: {}", path));
    }
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|e| format!("放行目录失败: {}", e))
}
