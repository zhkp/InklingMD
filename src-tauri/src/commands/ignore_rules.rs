// 统一的工作区忽略规则与递归遍历
//
// 本模块是忽略规则的**唯一真值源**，三个消费方共用：
//   1. 全局搜索（search.rs 的 collect_md_files 已改为本模块的薄封装）
//   2. 工作区文件索引（file_index.rs）
//   3. 文件树（mod.rs 的单层列目录）
//
// 忽略规则 = 一份默认目录黑名单（DEFAULT_IGNORED_DIRS）+ 工作区内的 .gitignore
//            + 隐藏项（名称以 `.` 开头）。
//
// 忽略来源穷举（不多不少）：
//   1. 默认目录黑名单：集合与历史 14 项**逐项一致**，不新增硬编码目录，
//      避免静默改变用户可见的搜索与索引结果；venv/vendor/Pods/__pycache__ 等由项目自带的
//      .gitignore 生效解决（这才是根因）。
//   2. 工作区内的 .gitignore（含嵌套子目录）。
//   3. 隐藏项 = 名称以 `.` 开头，与文件树（mod.rs 的 starts_with('.')）完全同语义，
//      跨平台一致，且**不含** Windows 隐藏属性语义。
// 明确不启用：`.ignore`（fd/ag 等工具的约定文件，会给用户带来界面上看不见的过滤来源）、
// git 全局排除、.git/info/exclude、祖先目录的 .gitignore。

use std::path::Path;

/// 默认忽略目录清单（唯一真值源）
///
/// 三个消费方（遍历器 / 文件树 / 索引）都**先**做「名称以 `.` 开头」的隐藏项判定、
/// **再**查本清单，因此其中 9 个以 `.` 开头的条目当前在全部消费方都是**不可达**的
/// ——判定结果并不依赖它们，真正让 `.git` 等不出现的是隐藏项规则。
///
/// 保留这 9 项的**唯一**理由是让本清单保持「忽略规格的完整快照」、与历史 14 项逐项一致，
/// 使将来若调整隐藏项规则时这些条目能立即成为有效防线。**不要以为它们当前在起作用。**
pub const DEFAULT_IGNORED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    ".next",
    ".nuxt",
    ".cache",
    ".codegraph",
    ".obsidian",
    ".git",
    ".svn",
    ".hg",
];

/// 工作区扫描的最大目录深度（搜索与文件索引共用同一上限，防异常深树）
pub const MAX_SCAN_DIR_DEPTH: usize = 64;

/// 目录名是否属于默认忽略清单（大小写不敏感）
pub fn is_ignored_dir(name: &str) -> bool {
    DEFAULT_IGNORED_DIRS
        .iter()
        .any(|ignored| name.eq_ignore_ascii_case(ignored))
}

/// 名称是否以 `suffix` 结尾（仅 ASCII 大小写折叠，零分配）
///
/// 按字节比较而非 `str` 切片：窗口可能落在多字节字符内部，
/// 对 `&str` 做 `name[len - suffix.len()..]` 会 panic。
fn ends_with_ignore_ascii_case(name: &str, suffix: &str) -> bool {
    let name = name.as_bytes();
    let suffix = suffix.as_bytes();
    name.len() >= suffix.len() && name[name.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// 文件名是否是 Markdown（大小写不敏感）
///
/// 只用 ASCII 折叠：后缀本身是 ASCII，`to_lowercase()` 的全 Unicode 映射在这里
/// 没有任何额外收益，却会给遍历到的每个文件带来一次堆分配。
pub fn is_markdown_name(name: &str) -> bool {
    ends_with_ignore_ascii_case(name, ".md") || ends_with_ignore_ascii_case(name, ".markdown")
}

/// 遍历失败原因
///
/// 刻意不使用 String：取消与「路径不存在」需要由调用方映射成各自的文案
/// （搜索结果与文件索引的历史文案不同，直接返回 String 会改变既有错误信息）。
/// 本类型只承载数据，**不提供统一文案方法**：两个调用方都必须先拦下 `Cancelled`
/// 换成自己的文案，任何「默认文案」都必然是不可达代码。
#[derive(Debug, PartialEq, Eq)]
pub enum WalkError {
    /// 被更新的请求取消（代次推进）
    Cancelled,
    /// 工作区路径不存在（携带原始路径，由调用方拼文案）
    NotFound(String),
}

/// 构造工作区遍历器（本模块是唯一配置点，改配置只改这里）
///
/// `max_dir_depth` 的语义与历史 `search.rs` 的 64 层目录上限一致
/// （该常量已并入本模块的 `MAX_SCAN_DIR_DEPTH`）：
/// 「包含文件的目录相对 root 的层数」，root 自身为 0 层。
/// ignore 的 `max_depth` 以「root = 0、直接子项 = 1」计数，位于 `d` 层目录内的文件
/// 处于 `d + 1` 层，故此处 +1 换算，从而保持既有深度边界不变。
fn build_walker(root: &Path, max_dir_depth: usize) -> ignore::Walk {
    let mut builder = ignore::WalkBuilder::new(root);
    builder
        // 隐藏项**不交给** ignore 的 hidden 过滤：它在 Windows 上走文件属性
        // （pathutil::is_hidden 会读 FILE_ATTRIBUTE_HIDDEN），于是带隐藏属性的普通文件
        // 会从搜索与索引里消失，而文件树（只看点号前缀）仍然显示它——同一文件两处结论相反；
        // 且在 ubuntu 上退化为点号前缀，两个平台的 CI 都抓不到差异。
        // 改为统一由下方 filter_entry 按点号前缀判定，与 commands/mod.rs 的文件树完全同语义。
        .hidden(false)
        // 不跟随符号链接：目录链接不成环，无需 visited 集合
        .follow_links(false)
        .max_depth(Some(max_dir_depth + 1))
        // 唯一的声明式忽略规则来源：工作区内的 .gitignore
        .git_ignore(true)
        // 关键：ignore 默认只在检测到 .git 目录时才应用 .gitignore。
        // 本产品的用户大量在**非 git 目录**下写 Markdown，不设为 false 则该功能形同未做。
        .require_git(false)
        // 只认工作区内的 .gitignore，不向上读祖先目录的规则：
        // 祖先规则会随机器/临时目录环境变化，属不可复现的结果来源
        // （测试用 std::env::temp_dir()，用户主目录也可能存在规则）。
        .parents(false)
        // 关闭机器相关的 git 全局排除与 .git/info/exclude，保证跨机器可复现
        .git_global(false)
        .git_exclude(false)
        // 关闭 `.ignore`（fd/ag 等工具的约定文件）：它是本次改动之外的**新增过滤来源**，
        // 会让用户在界面上看不到任何规则来源却搜不到文件。本 PR 的契约收紧为
        // 「默认黑名单 + 工作区内 .gitignore + 点号前缀隐藏项」（与模块头「忽略来源穷举」
        // 的三项一致），故显式关闭而非沿用 ignore 的默认 true。
        .ignore(false)
        // 隐藏项 + 默认黑名单剪枝（唯一判定点）
        .filter_entry(|entry| {
            // root 自身不参与名字判定：否则把名为 target/out 的目录当作工作区打开时会全空
            if entry.depth() == 0 {
                return true;
            }
            // to_string_lossy 在合法 UTF-8 时零分配；非 UTF-8 名称沿用历史的有损比较行为
            let name = entry.file_name().to_string_lossy();
            // 隐藏项 = 名称以 `.` 开头。与 commands/mod.rs 的文件树判定完全一致，
            // 跨平台一致，且不含 Windows 隐藏属性语义（那会静默吞掉用户能看见的笔记）。
            if name.starts_with('.') {
                return false;
            }
            // 默认黑名单只对目录生效，不误伤同名文件
            if entry.file_type().is_some_and(|ft| ft.is_dir()) {
                return !is_ignored_dir(&name);
            }
            true
        })
        .build()
}

/// 递归收集工作区内的 Markdown 文件
///
/// - `root`：工作区根目录（调用方负责保证是目录；若传入文件，遍历器会产出该文件自身）
/// - `max_dir_depth`：目录层数上限，语义见 `build_walker`
/// - `max_files`：产出上限，达到后停止并置 `truncated`
/// - `is_cancelled`：取消判定钩子。由调用方注入，从而让搜索与索引各自持有独立代次，
///   不会出现「打开 Quick Open 把在途全局搜索取消掉」的耦合
///
/// 返回 `(files, truncated)`：
/// - `files` 按路径字节序升序（与历史 `files.sort()` 一致，保证分片并行扫描的合并顺序确定）；
///   **路径为平台原生分隔符**（Windows 为 `\`），与 `list_dir` 及搜索结果的 `path` 字段一致，
///   调用方展示前需自行归一化（如 `replace('\\', "/")`）。
/// - `truncated` 仅在确实存在第 `max_files + 1` 个**可收录**文件时为 true。
///
/// 读取失败与非 UTF-8 路径静默跳过，不中断整个遍历。
pub fn walk_markdown_files(
    root: &Path,
    max_dir_depth: usize,
    max_files: usize,
    is_cancelled: &dyn Fn() -> bool,
) -> Result<(Vec<String>, bool), WalkError> {
    if !root.exists() {
        return Err(WalkError::NotFound(root.to_string_lossy().into_owned()));
    }

    let mut files: Vec<String> = Vec::new();
    let mut truncated = false;

    for entry in build_walker(root, max_dir_depth) {
        if is_cancelled() {
            return Err(WalkError::Cancelled);
        }
        // 权限错误等条目静默跳过（与历史 collect_md_files 的 Err(_) => return Ok(()) 一致）
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let Some(file_type) = entry.file_type() else {
            continue;
        };
        // 文件符号链接按文件处理（与历史实现一致：只跳过目录链接）
        let is_file = if file_type.is_symlink() {
            std::fs::metadata(entry.path()).is_ok_and(|meta| meta.is_file())
        } else {
            file_type.is_file()
        };
        if !is_file {
            continue;
        }
        if !is_markdown_name(&entry.file_name().to_string_lossy()) {
            continue;
        }
        // 先确认路径可表示为 UTF-8，再判上限：顺序反了的话，Linux 上遇到非 UTF-8 路径
        // 会被误当成「还有第 N+1 个可收录文件」而置 truncated=true——它反正收不进来，
        // 属假截断（调用方会据此以为工作区被截断，实际没有）。
        let Some(path) = entry.path().to_str() else {
            continue;
        };
        if files.len() >= max_files {
            truncated = true;
            break;
        }
        files.push(path.to_string());
    }

    files.sort();
    Ok((files, truncated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    /// 临时目录，Drop 时自动清理
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
                "inklingmd-ignore-{label}-{}-{nonce}-{sequence}",
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

    fn walk(root: &Path) -> Vec<String> {
        walk_with(root, 64, usize::MAX, &|| false).0
    }

    fn walk_with(
        root: &Path,
        max_depth: usize,
        max_files: usize,
        is_cancelled: &dyn Fn() -> bool,
    ) -> (Vec<String>, bool) {
        walk_markdown_files(root, max_depth, max_files, is_cancelled).expect("walk should succeed")
    }

    /// 把绝对路径列表转成相对 root 的 POSIX 风格相对路径，便于断言
    fn relative(root: &Path, files: &[String]) -> Vec<String> {
        let mut out: Vec<String> = files
            .iter()
            .map(|p| {
                Path::new(p)
                    .strip_prefix(root)
                    .expect("walked file should live under root")
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect();
        out.sort();
        out
    }

    #[test]
    fn only_markdown_files_are_returned_with_case_insensitive_extension() {
        let temp = TestDir::new("markdown-only");
        write(&temp.child("a.md"), "# a");
        write(&temp.child("b.markdown"), "# b");
        write(&temp.child("c.MD"), "# c");
        write(&temp.child("d.txt"), "d");
        write(&temp.child("e.mdx"), "e");

        let (files, truncated) = walk_with(&temp.path, 64, usize::MAX, &|| false);
        assert_eq!(
            relative(&temp.path, &files),
            vec!["a.md", "b.markdown", "c.MD"]
        );
        assert!(!truncated);
    }

    /// 目录符号链接不被跟随：内容不进结果，且**自指链接不会造成无限遍历**
    ///
    /// Windows 未开开发者模式时创建符号链接会失败，故 Windows 侧用 `mklink /J` 建目录联接
    /// （不需要管理员/开发者模式，与 `commands/mod.rs` 的既有 symlink 用例同一手法）。
    #[cfg(unix)]
    #[test]
    fn directory_symlinks_are_not_followed() {
        use std::os::unix::fs::symlink;

        let temp = TestDir::new("dir-symlink");
        write(&temp.child("real/inside.md"), "# inside");
        write(&temp.child("visible.md"), "# visible");
        symlink(temp.path.join("real"), temp.child("linked")).unwrap();
        symlink(&temp.path, temp.child("loop")).unwrap();

        let files = walk(&temp.path);

        assert_eq!(
            relative(&temp.path, &files),
            vec!["real/inside.md", "visible.md"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn directory_symlinks_are_not_followed() {
        use std::process::Command;

        let temp = TestDir::new("dir-symlink");
        write(&temp.child("real/inside.md"), "# inside");
        write(&temp.child("visible.md"), "# visible");
        for (link, target) in [
            (temp.child("linked"), temp.path.join("real")),
            (temp.child("loop"), temp.path.clone()),
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

        let files = walk(&temp.path);

        assert_eq!(
            relative(&temp.path, &files),
            vec!["real/inside.md", "visible.md"]
        );
    }

    /// 文件符号链接按文件处理（与历史实现一致：只跳过**目录**链接）
    #[test]
    fn file_symlinks_are_treated_as_files() {
        let temp = TestDir::new("file-symlink");
        write(&temp.child("real.md"), "# real");
        #[cfg(unix)]
        let created =
            std::os::unix::fs::symlink(temp.child("real.md"), temp.child("link.md")).is_ok();
        #[cfg(windows)]
        let created =
            std::os::windows::fs::symlink_file(temp.child("real.md"), temp.child("link.md"))
                .is_ok();
        #[cfg(not(any(unix, windows)))]
        let created = false;
        // 无创建符号链接权限时 `symlink_file` 的**返回值不可靠**，实测到两种表现：
        // 普通非提权进程返回 `Err(1314)`（「客户端没有所需的特权。」），
        // 而本项目的测试环境里会返回 `Ok(())` 却并未真的建出链接 —— 同一环境下
        // `commands/mod.rs` 的既有 symlink 用例也因此越过 `is_ok()` 守卫、在后续断言上失败。
        // 所以跳过判据必须落到「链接确实可用」；只看创建调用的返回值会在这里假失败。
        if !created || !temp.child("link.md").exists() {
            return; // 平台无创建符号链接权限，跳过
        }

        let files = walk(&temp.path);

        assert_eq!(relative(&temp.path, &files), vec!["link.md", "real.md"]);
    }

    #[test]
    fn hidden_files_and_directories_are_skipped() {
        let temp = TestDir::new("hidden");
        write(&temp.child("visible.md"), "visible");
        write(&temp.child(".hidden.md"), "hidden file");
        write(&temp.child(".hidden/inside.md"), "hidden dir");

        let files = walk(&temp.path);
        assert_eq!(relative(&temp.path, &files), vec!["visible.md"]);
    }

    #[test]
    fn dotfile_convention_ignore_file_is_not_honoured() {
        // 契约锁定：忽略来源只有「默认黑名单 + .gitignore + 隐藏项」，
        // `.ignore`（fd/ag 的约定文件）**不生效**——它会让用户看到文件消失却找不到规则来源。
        let temp = TestDir::new("dot-ignore-disabled");
        write(&temp.child(".ignore"), "secret.md\n");
        write(&temp.child("secret.md"), "kept");
        write(&temp.child("keep.md"), "kept");

        let files = walk(&temp.path);
        assert_eq!(
            relative(&temp.path, &files),
            vec!["keep.md", "secret.md"],
            ".ignore 不得过滤文件；否则是界面上不可见的静默过滤来源"
        );
    }

    /// Windows 隐藏属性（FILE_ATTRIBUTE_HIDDEN）**不算**隐藏项
    ///
    /// 若把隐藏项判定交给 ignore 的 `hidden(true)`，Windows 上会走文件属性，
    /// 于是「文件树里看得见、搜索里搜不到」——同一文件两处结论相反。
    /// 本用例锁定「与文件树同语义」：只有点号前缀算隐藏。
    #[cfg(windows)]
    #[test]
    fn windows_hidden_attribute_is_not_treated_as_hidden() {
        use std::process::Command;

        fn set_hidden(path: &Path) {
            let status = Command::new("cmd")
                .args(["/C", "attrib", "+h"])
                .arg(path)
                .status()
                .expect("run attrib +h");
            assert!(status.success(), "attrib +h 应执行成功: {}", path.display());
        }

        let temp = TestDir::new("windows-hidden-attr");
        write(&temp.child("visible.md"), "visible");
        let hidden_file = temp.child("attr-hidden.md");
        write(&hidden_file, "hidden attribute on a file");
        let hidden_dir = temp.child("attr-hidden-dir");
        write(
            &hidden_dir.join("inside.md"),
            "file inside a hidden-attribute dir",
        );

        set_hidden(&hidden_file);
        set_hidden(&hidden_dir);

        let files = walk(&temp.path);
        assert_eq!(
            relative(&temp.path, &files),
            vec!["attr-hidden-dir/inside.md", "attr-hidden.md", "visible.md"],
            "Windows 隐藏属性不得影响收录结果（与文件树 starts_with('.') 判定一致）"
        );
    }

    #[test]
    fn is_markdown_name_handles_multibyte_tails_without_panicking() {
        // 后缀比较按字节做：多字节字符结尾时不得因切到字符内部而 panic
        assert!(!is_markdown_name("x😀"));
        assert!(is_markdown_name("😀.md"));
        assert!(is_markdown_name("日本語.MARKDOWN"));
        assert!(!is_markdown_name(".md.txt"));
    }

    #[test]
    fn files_are_returned_in_deterministic_path_order() {
        let temp = TestDir::new("order");
        write(&temp.child("z.md"), "z");
        write(&temp.child("a.md"), "a");
        write(&temp.child("nested/m.md"), "m");

        let files = walk(&temp.path);
        let mut expected = files.clone();
        expected.sort();
        assert_eq!(
            files, expected,
            "遍历结果必须按路径字节序升序，保证分片合并顺序确定"
        );
    }

    #[test]
    fn directory_depth_boundary_matches_legacy_semantics() {
        // 既有 search.rs 的边界：位于 64 层目录内的文件收录，65 层的丢弃
        const DIR_DEPTH: usize = 64;
        let temp = TestDir::new("depth");
        let mut current = temp.path.clone();
        for depth in 1..=DIR_DEPTH + 1 {
            current = current.join(format!("level-{depth}"));
            fs::create_dir(&current).unwrap();
            if depth == DIR_DEPTH {
                write(&current.join("included.md"), "needle");
            }
            if depth == DIR_DEPTH + 1 {
                write(&current.join("excluded.md"), "needle");
            }
        }

        let files = walk(&temp.path);
        assert_eq!(files.len(), 1, "只有 64 层的文件应被收录");
        assert!(files[0].ends_with("included.md"));
    }

    #[test]
    fn gitignore_skips_listed_directory_even_without_git_dir() {
        let temp = TestDir::new("gitignore-dir");
        // 刻意不创建 .git：锁定 require_git(false)
        write(&temp.child(".gitignore"), "artifacts/\n");
        write(&temp.child("artifacts/report.md"), "ignored");
        write(&temp.child("keep.md"), "kept");

        let files = walk(&temp.path);
        assert_eq!(relative(&temp.path, &files), vec!["keep.md"]);
    }

    #[test]
    fn gitignore_wildcard_pattern_is_respected() {
        let temp = TestDir::new("gitignore-wildcard");
        write(&temp.child(".gitignore"), "*.draft.md\n");
        write(&temp.child("a.draft.md"), "ignored");
        write(&temp.child("b.md"), "kept");

        let files = walk(&temp.path);
        assert_eq!(relative(&temp.path, &files), vec!["b.md"]);
    }

    #[test]
    fn gitignore_negation_rule_keeps_the_file() {
        let temp = TestDir::new("gitignore-negation");
        // 同目录的文件级取反：避开 git「父目录被排除后无法反选子项」的语义陷阱
        write(&temp.child(".gitignore"), "*.tmp.md\n!keep.tmp.md\n");
        write(&temp.child("a.tmp.md"), "ignored");
        write(&temp.child("keep.tmp.md"), "kept");

        let files = walk(&temp.path);
        assert_eq!(relative(&temp.path, &files), vec!["keep.tmp.md"]);
    }

    #[test]
    fn nested_gitignore_applies_only_to_its_subtree() {
        let temp = TestDir::new("gitignore-nested");
        write(&temp.child("sub/.gitignore"), "secret.md\n");
        write(&temp.child("sub/secret.md"), "ignored");
        write(&temp.child("sub/other.md"), "kept");
        // 同名文件在别处不受子目录规则影响
        write(&temp.child("secret.md"), "kept");

        let files = walk(&temp.path);
        assert_eq!(
            relative(&temp.path, &files),
            vec!["secret.md", "sub/other.md"]
        );
    }

    #[test]
    fn ancestor_gitignore_outside_workspace_is_not_applied() {
        let temp = TestDir::new("gitignore-ancestor");
        // 祖先目录的规则必须被忽略（parents(false)）：否则结果会随机器环境变化
        write(&temp.child(".gitignore"), "workspace.md\n");
        let workspace = temp.child("workspace");
        fs::create_dir_all(&workspace).unwrap();
        write(&workspace.join("workspace.md"), "kept");

        let files = walk(&workspace);
        assert_eq!(relative(&workspace, &files), vec!["workspace.md"]);
    }

    #[test]
    fn default_blacklist_directories_are_skipped() {
        let temp = TestDir::new("blacklist");
        for dir in DEFAULT_IGNORED_DIRS {
            write(&temp.child(&format!("{dir}/inside.md")), "ignored");
        }
        write(&temp.child("src/main.md"), "kept");

        let files = walk(&temp.path);
        assert_eq!(relative(&temp.path, &files), vec!["src/main.md"]);
    }

    #[test]
    fn workspace_root_named_like_a_blacklist_entry_is_still_scanned() {
        // 目录名恰好是 out/target 时，root 自身不得被剪枝（否则整个工作区全空）
        let temp = TestDir::new("root-named-out");
        let workspace = temp.child("out");
        fs::create_dir_all(&workspace).unwrap();
        write(&workspace.join("note.md"), "kept");

        let files = walk(&workspace);
        assert_eq!(relative(&workspace, &files), vec!["note.md"]);
    }

    #[test]
    fn exceeding_max_files_sets_truncated_flag() {
        let temp = TestDir::new("max-files");
        for index in 0..5 {
            write(&temp.child(&format!("f{index}.md")), "x");
        }

        let (files, truncated) = walk_with(&temp.path, 64, 2, &|| false);
        assert_eq!(files.len(), 2);
        assert!(truncated, "达到上限必须对调用方可见");
    }

    #[test]
    fn cancelled_walk_returns_cancelled_error() {
        let temp = TestDir::new("cancel");
        write(&temp.child("a.md"), "a");

        let result = walk_markdown_files(&temp.path, 64, usize::MAX, &|| true);
        assert_eq!(result, Err(WalkError::Cancelled));
    }

    #[test]
    fn nonexistent_root_reports_not_found() {
        let temp = TestDir::new("missing");
        let missing = temp.child("does-not-exist");

        let result = walk_markdown_files(&missing, 64, usize::MAX, &|| false);
        assert_eq!(
            result,
            Err(WalkError::NotFound(missing.to_string_lossy().into_owned()))
        );
    }

    #[test]
    fn empty_workspace_returns_empty_list() {
        let temp = TestDir::new("empty");
        let (files, truncated) = walk_with(&temp.path, 64, usize::MAX, &|| false);
        assert!(files.is_empty());
        assert!(!truncated);
    }

    #[test]
    fn is_ignored_dir_is_case_insensitive() {
        assert!(is_ignored_dir("node_modules"));
        assert!(is_ignored_dir("NODE_MODULES"));
        assert!(is_ignored_dir("dist"));
        assert!(!is_ignored_dir("src"));
        assert!(!is_ignored_dir("docs"));
    }

    #[test]
    fn is_markdown_name_handles_compound_extensions() {
        assert!(is_markdown_name("a.md"));
        assert!(is_markdown_name("a.MARKDOWN"));
        assert!(!is_markdown_name("a.md.txt"));
        assert!(!is_markdown_name("a.txt"));
    }
}
