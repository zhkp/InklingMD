// 工作区文件索引命令（#227）
//
// 递归列出工作区内全部 Markdown 文件，供 Quick Open 的实时过滤使用。
// 忽略规则（隐藏项 / 默认黑名单 / .gitignore）、符号链接处理与深度上限
// 全部由 ignore_rules 模块提供，本模块只负责「代次 + 上限 + IPC 边界」。

use super::ignore_rules::{self, WalkError};
use super::{is_stale_with, next_generation};
use std::path::Path;
use std::sync::atomic::AtomicU64;

/// 单次索引最多返回的文件数，超出截断并置 truncated
///
/// 50_000 条绝对路径约 6MB 量级，属可接受上限；再大说明工作区不适合整体索引。
pub const MAX_INDEX_FILES: usize = 50_000;

/// 索引代次计数器
///
/// **代次由 Rust 侧分配**（`next_generation`），命令不接受前端传来的计数。原因是前端
/// 每个 webview 都是全新 JS 上下文、各自从 0 开始计数（现有搜索侧就是这种写法）：
/// 多窗口下后打开窗口传来的小代次会被 `fetch_max` 挡在全局之外，于是它的**每一次**请求
/// 都被判为过期——是「后开窗口被永久饿死」，不是「后发起者胜出」。由服务端分配则对任意
/// 并发请求严格单调，跨窗口自然成立「最新请求胜出」，且前端无需维护任何计数器。
///
/// 刻意**不复用** `SEARCH_GENERATION`：两者共用一个计数器会让「打开 Quick Open」
/// 把在途的全局搜索取消掉，属可观察的行为耦合；复用是「机制」（代次 + 检查点提前退出），
/// 不是变量。搜索侧（`SEARCH_GENERATION`）自 #241 起与索引侧同构：代次同样由 Rust 侧
/// 分配（`commands::next_generation`），两侧各自维护独立计数器。
pub static INDEX_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 工作区文件索引结果
#[derive(Debug, serde::Serialize)]
pub struct WorkspaceFileList {
    /// 工作区内全部 Markdown 文件的完整路径，按路径字节序升序。
    ///
    /// 路径为**平台原生分隔符**（Windows 为 `\`），与 `list_dir` 及搜索结果的
    /// `path` 字段保持一致；调用方展示或做相对路径匹配前需自行归一化。
    pub files: Vec<String>,
    /// 文件数达到上限被截断时为 true（与搜索结果的 truncated 语义相同）
    pub truncated: bool,
}

/// 索引被更新的索引取消
fn cancelled_error() -> String {
    "索引已被更新的请求取消".to_string()
}

/// 列出工作区内全部 Markdown 文件
///
/// 代次在本命令内分配（见 `INDEX_GENERATION`），因此前端**不需要**、也不应传入代次。
#[tauri::command]
pub async fn list_workspace_files(root: String) -> Result<WorkspaceFileList, String> {
    let generation = next_generation(&INDEX_GENERATION);
    tauri::async_runtime::spawn_blocking(move || {
        list_workspace_files_with(&root, MAX_INDEX_FILES, &|| {
            is_stale_with(&INDEX_GENERATION, generation)
        })
    })
    .await
    .map_err(|e| format!("索引任务执行失败: {e}"))?
}

/// 索引实现：取消判定由调用方注入，从而可用固定桩单测（无需触碰全局代次）
///
/// `root` 为文件时**无需特判**：`walk_markdown_files` 对文件根会产出该文件自身，
/// 其 markdown 判定与 UTF-8 路径判定与本函数同源；特判会形成第二份逻辑并最终漂移。
fn list_workspace_files_with(
    root: &str,
    max_files: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<WorkspaceFileList, String> {
    let (files, truncated) = ignore_rules::walk_markdown_files(
        Path::new(root),
        ignore_rules::MAX_SCAN_DIR_DEPTH,
        max_files,
        is_cancelled,
    )
    .map_err(|error| match error {
        WalkError::Cancelled => cancelled_error(),
        // 与 search_in_workspace_sync 的历史文案保持一致
        WalkError::NotFound(path) => format!("工作区不存在: {path}"),
    })?;

    Ok(WorkspaceFileList { files, truncated })
}

#[cfg(test)]
mod tests {
    use super::super::search::SEARCH_GENERATION;
    use super::*;
    use std::fs;
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
                "inklingmd-index-{label}-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }

        fn child(&self, relative: &str) -> PathBuf {
            self.path.join(relative)
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write(path: &PathBuf, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent directory");
        }
        fs::write(path, content).expect("write test file");
    }

    /// 把绝对路径列表转成相对 root 的 POSIX 相对路径并排序，便于断言
    fn relative(root: &Path, files: &[String]) -> Vec<String> {
        let mut out: Vec<String> = files
            .iter()
            .map(|p| {
                Path::new(p)
                    .strip_prefix(root)
                    .expect("indexed file should live under root")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        out.sort();
        out
    }

    /// 走被测实现，取消判定注入固定桩（不触碰全局代次）
    fn index_with(
        root: &Path,
        max_files: usize,
        is_cancelled: &dyn Fn() -> bool,
    ) -> Result<WorkspaceFileList, String> {
        list_workspace_files_with(&root.to_string_lossy(), max_files, is_cancelled)
    }

    fn index(root: &Path) -> WorkspaceFileList {
        index_with(root, MAX_INDEX_FILES, &|| false).expect("index should succeed")
    }

    #[test]
    fn lists_markdown_files_recursively_and_skips_other_files() {
        let temp = TestDir::new("recursive");
        write(&temp.child("root.md"), "root");
        write(&temp.child("notes/deep/todo.markdown"), "todo");
        write(&temp.child("notes/image.png"), "binary");
        write(&temp.child("notes/data.txt"), "text");

        let result = index(&temp.path);
        assert_eq!(
            relative(&temp.path, &result.files),
            vec!["notes/deep/todo.markdown", "root.md"]
        );
        assert!(!result.truncated);
    }

    #[test]
    fn gitignore_is_applied_through_the_index_command() {
        let temp = TestDir::new("gitignore");
        // 非 git 目录也必须生效（require_git(false)）
        write(&temp.child(".gitignore"), "artifacts/\n");
        write(&temp.child("artifacts/generated.md"), "ignored");
        write(&temp.child("note.md"), "kept");

        let result = index(&temp.path);
        assert_eq!(relative(&temp.path, &result.files), vec!["note.md"]);
    }

    #[test]
    fn index_is_truncated_at_max_files_with_visible_flag() {
        let temp = TestDir::new("truncate");
        for i in 0..5 {
            write(&temp.child(&format!("f{i}.md")), "x");
        }

        let result = index_with(&temp.path, 2, &|| false).expect("index should succeed");
        assert_eq!(result.files.len(), 2);
        assert!(result.truncated, "截断必须对调用方可见");
    }

    #[test]
    fn file_root_returns_itself_only_when_markdown() {
        // 不特判文件根：由 walker 产出该条目自身（避免第二份 markdown 判定逻辑）
        let temp = TestDir::new("file-root");
        let md = temp.child("single.md");
        write(&md, "# single");
        let txt = temp.child("single.txt");
        write(&txt, "text");

        let md_result = index(&md);
        assert_eq!(md_result.files.len(), 1);
        assert!(md_result.files[0].ends_with("single.md"));

        let txt_result = index(&txt);
        assert!(txt_result.files.is_empty());
    }

    #[test]
    fn nonexistent_root_reports_workspace_missing() {
        let temp = TestDir::new("missing");
        let err = index_with(&temp.child("nope"), MAX_INDEX_FILES, &|| false).unwrap_err();
        assert!(
            err.contains("工作区不存在"),
            "错误应为工作区不存在，实际: {err}"
        );
    }

    #[test]
    fn cancelled_index_reports_cancelled_message() {
        // 取消判定注入固定桩，无需写全局代次即可覆盖「取消 → 专属文案」这条链路
        let temp = TestDir::new("cancel");
        write(&temp.child("a.md"), "a");

        let err = index_with(&temp.path, MAX_INDEX_FILES, &|| true).unwrap_err();
        assert!(err.contains("取消"), "被取消的索引应报取消，实际: {err}");
    }

    #[test]
    fn allocated_generations_are_strictly_increasing() {
        // 用本地计数器验证分配逻辑：严格单调 ⇒ 任意并发请求中「最新者的代次最大」
        let counter = AtomicU64::new(0);
        let first = next_generation(&counter);
        let second = next_generation(&counter);
        let third = next_generation(&counter);

        assert!(first < second && second < third);
        assert_eq!(
            counter.load(Ordering::Relaxed),
            third,
            "返回的代次即全局当前值"
        );
    }

    #[test]
    fn staleness_is_strictly_greater_than_its_own_counter() {
        // 判定只读传入的计数器：相等不算过期、更小算过期、更大不算
        let counter = AtomicU64::new(5);
        assert!(!is_stale_with(&counter, 5));
        assert!(is_stale_with(&counter, 4));
        assert!(!is_stale_with(&counter, 6));

        counter.store(u64::MAX, Ordering::Relaxed);
        assert!(!is_stale_with(&counter, u64::MAX), "极大值边界不应误判过期");
    }

    #[test]
    fn index_generation_is_independent_from_search_generation() {
        // 本用例写全局代次，必须与 search::generation_cancel_semantics 互斥（#227 复审 P2-1）
        let _generations = crate::commands::lock_generations();

        let temp = TestDir::new("independent-generation");
        write(&temp.child("a.md"), "a");

        // 把搜索代次推到极大：若索引误用搜索代次做判定，下面的索引会立刻被判过期
        SEARCH_GENERATION.store(u64::MAX, Ordering::Relaxed);

        let generation = next_generation(&INDEX_GENERATION);
        let result =
            list_workspace_files_with(&temp.path.to_string_lossy(), MAX_INDEX_FILES, &|| {
                is_stale_with(&INDEX_GENERATION, generation)
            })
            .expect("索引的取消判定不得依赖搜索代次");
        assert_eq!(result.files.len(), 1);
    }
}
