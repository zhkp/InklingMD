// 全局搜索命令
// 遍历工作区目录下所有 .md/.markdown 文件，按行匹配关键词或正则，
// 返回命中结果（文件路径 + 行号 + 列号 + 预览文本）与截断标记。
// 忽略规则（隐藏项 / 默认黑名单 / .gitignore）与目录符号链接处理统一由
// ignore_rules 模块提供（#227），此处不再维护第二份目录黑名单。
// 性能要点（#163）：目录符号链接一律不跟随，递归路径天然是树，无需逐目录 canonicalize；
// 文件扫描按 CPU 数分片并行；搜索代次（generation）推进时旧任务在周期间检查点提前退出。

use super::ignore_rules;
use super::{is_stale_with, next_generation};
use regex::Regex;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::sync::atomic::AtomicU64;

/// 单条命中
#[derive(Debug, serde::Serialize)]
pub struct SearchHit {
    /// 文件完整路径
    pub path: String,
    /// 行号（从 1 开始）
    pub line: usize,
    /// 列号（从 1 开始，按 UTF-8 字符计）
    pub column: usize,
    /// 命中点附近的预览文本（截断窗口，非整行，见 preview_window）
    pub preview: String,
}

/// 全局搜索结果（#160：截断对前端可见）
#[derive(Debug, serde::Serialize)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// 命中数达到上限被截断时为 true
    pub truncated: bool,
}

/// 超过此大小（字节）的文件跳过
const MAX_FILE_SIZE: u64 = 5 * 1024 * 1024;
/// 单次搜索最多返回的命中条数，超出截断并置 truncated
const MAX_TOTAL_HITS: usize = 5000;
/// preview 中命中点前后各保留的字符数（#176：避免克隆整行）
const PREVIEW_CONTEXT_CHARS: usize = 120;
/// preview 中命中片段本身最多保留的字符数（防超大正则匹配撑爆预览）
const PREVIEW_MAX_MATCH_CHARS: usize = 200;

/// 扫描行数达到该倍数时检查一次取消（摊薄原子读开销）
const CANCEL_CHECK_LINE_INTERVAL: usize = 256;

/// 搜索代次：每次新搜索在命令入口由 Rust 侧分配（#241），
/// 在途旧任务发现代次推进后提前退出（#163）
pub static SEARCH_GENERATION: AtomicU64 = AtomicU64::new(0);

/// 搜索被更新的搜索取消
fn cancelled_error() -> String {
    "搜索已被更新的搜索取消".to_string()
}

/// 当前代次是否已被更新的搜索推进
fn is_stale(generation: u64) -> bool {
    is_stale_with(&SEARCH_GENERATION, generation)
}

/// 递归收集目录下所有 .md/.markdown 文件路径
///
/// 已统一到 `ignore_rules::walk_markdown_files`（#227）：忽略规则、隐藏项判定、
/// 符号链接处理、深度上限与默认黑名单只有一份实现，由搜索 / 文件索引 / 文件树共用。
///
/// `max_files` 传 `usize::MAX`：产出上限只对文件索引生效，搜索必须拿到全部候选文件，
/// 因此这里刻意丢弃 `truncated`。
fn collect_md_files(dir: &Path, generation: u64) -> Result<Vec<String>, String> {
    let is_cancelled = || is_stale(generation);
    ignore_rules::walk_markdown_files(
        dir,
        ignore_rules::MAX_SCAN_DIR_DEPTH,
        usize::MAX,
        &is_cancelled,
    )
    .map(|(files, _)| files)
    .map_err(|error| match error {
        // 搜索沿用自己既有的取消文案（与索引的文案不同）
        ignore_rules::WalkError::Cancelled => cancelled_error(),
        ignore_rules::WalkError::NotFound(path) => format!("工作区不存在: {path}"),
    })
}

/// 取命中点附近的字符级窗口作为预览（#176）
///
/// 形如「…前文(≤120 字符) 命中片段(≤200 字符) 后文(≤120 字符)…」。
/// 内嵌 base64 图片的超长单行不再被整行克隆，5000 条命中的预览总量被常数级封顶。
fn preview_window(line: &str, start: usize, end: usize) -> String {
    // 命中前保留的窗口起点（按字符数回退）
    let from = match line[..start]
        .char_indices()
        .rev()
        .nth(PREVIEW_CONTEXT_CHARS - 1)
    {
        Some((i, _)) => i,
        None => 0,
    };
    // 命中片段本身超长时截断
    let match_end = match line[start..end].char_indices().nth(PREVIEW_MAX_MATCH_CHARS) {
        Some((i, _)) => start + i,
        None => end,
    };
    // 命中后保留的窗口终点（按字符数前进）
    let to = match line[match_end..].char_indices().nth(PREVIEW_CONTEXT_CHARS) {
        Some((i, _)) => match_end + i,
        None => line.len(),
    };

    let mut preview = String::with_capacity(to - from + '…'.len_utf8() * 2);
    if from > 0 {
        preview.push('…');
    }
    preview.push_str(&line[from..to]);
    if to < line.len() {
        preview.push('…');
    }
    preview
}

/// 顺序扫描一片文件，命中数在本片内达到上限后继续探测是否还有更多命中。
///
/// 返回 `(hits, exceeded)`：
/// - `hits`：本片实际匹配，收集到 `MAX_TOTAL_HITS` 后不再存储（防内存膨胀）；
/// - `exceeded`：本片真实命中数超过 `MAX_TOTAL_HITS`（存在第 `MAX_TOTAL_HITS+1` 条未收录）。
///
/// 判定要点：若恰好 `MAX_TOTAL_HITS` 条（扫描到末尾仍无多余），则 `exceeded = false`，
/// 从而避免「命中数恰好 5000 也被截断」的误报。代次推进时返回取消错误。
fn scan_files(
    files: &[String],
    re: &Regex,
    generation: u64,
) -> Result<(Vec<SearchHit>, bool), String> {
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut exceeded = false;
    'outer: for file_path in files {
        if is_stale(generation) {
            return Err(cancelled_error());
        }
        // 跳过超大文件
        if let Ok(meta) = std::fs::metadata(file_path) {
            if meta.len() > MAX_FILE_SIZE {
                continue;
            }
        }
        let file = match File::open(file_path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let reader = BufReader::new(file);
        for (i, line_res) in reader.lines().enumerate() {
            if i % CANCEL_CHECK_LINE_INTERVAL == 0 && is_stale(generation) {
                return Err(cancelled_error());
            }
            let line = match line_res {
                Ok(l) => l,
                Err(_) => continue,
            };
            for m in re.find_iter(&line) {
                // 收集已满：继续向后探测，直到确认存在多余命中才标记 exceeded，
                // 而不是一到达 MAX 就假定被截断（避免恰好上限的误报）。
                if hits.len() >= MAX_TOTAL_HITS {
                    exceeded = true;
                    break 'outer;
                }
                // 列号按 UTF-8 字符计（前端展示更直观）
                let column = line[..m.start()].chars().count() + 1;
                hits.push(SearchHit {
                    path: file_path.clone(),
                    line: i + 1,
                    column,
                    preview: preview_window(&line, m.start(), m.end()),
                });
            }
        }
    }
    Ok((hits, exceeded))
}

/// 全局搜索：在工作区 root 下搜索 query
///
/// - `root`: 工作区根目录
/// - `query`: 搜索词或正则
/// - `case_sensitive`: 是否区分大小写
/// - `use_regex`: 是否作为正则匹配
///
/// 代次由本命令在 **Rust 侧分配**（#241）：前端每个 webview 都是独立 JS 上下文、各自从 0
/// 计数，多窗口下后开窗口的请求会被永久判过期；服务端 `fetch_add` 分配则对任意并发请求
/// 严格单调，跨窗口自然成立「最新请求胜出」。命令入口先登记代次——在途旧任务在检查点
/// 看到代次推进后提前退出（#163）。
#[tauri::command]
pub async fn search_in_workspace(
    root: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
) -> Result<SearchResult, String> {
    let generation = next_generation(&SEARCH_GENERATION);
    tauri::async_runtime::spawn_blocking(move || {
        search_in_workspace_sync(root, query, case_sensitive, use_regex, generation)
    })
    .await
    .map_err(|e| format!("搜索任务执行失败: {e}"))?
}

fn search_in_workspace_sync(
    root: String,
    query: String,
    case_sensitive: bool,
    use_regex: bool,
    generation: u64,
) -> Result<SearchResult, String> {
    if query.is_empty() {
        return Ok(SearchResult {
            hits: Vec::new(),
            truncated: false,
        });
    }

    // 构建正则
    let pattern = if use_regex {
        query.clone()
    } else {
        // 转义正则元字符
        regex::escape(&query)
    };
    let flags = if case_sensitive { "" } else { "(?i)" };
    let full = format!("{}{}", flags, pattern);
    let re = Regex::new(&full).map_err(|e| format!("正则编译失败: {}", e))?;

    let root_path = Path::new(&root);
    if !root_path.exists() {
        return Err(format!("工作区不存在: {}", root));
    }

    // walk_markdown_files 已按路径字节序升序返回，分片合并顺序因此确定（#163）
    let files: Vec<String> = if root_path.is_dir() {
        collect_md_files(root_path, generation)?
    } else if root_path.is_file() {
        // 单文件模式沿用历史行为：不限定扩展名，任意文件都可作为搜索目标
        root_path
            .to_str()
            .map(|path| vec![path.to_string()])
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    if is_stale(generation) {
        return Err(cancelled_error());
    }

    // 按可用 CPU 数把已排序文件切片，分片并行扫描后按片序合并，保证结果顺序确定（#163）
    let mut hits: Vec<SearchHit> = Vec::new();
    // 任一单片探测到超上限，则整体必然截断；各片未超上限时总计严格超过上限才算截断
    // （恰好 5000 条不误报）。
    let mut truncated = false;
    if !files.is_empty() {
        let worker_count = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .min(files.len());
        let chunk_size = (files.len() + worker_count - 1) / worker_count;
        let re_ref = &re;
        let parts = std::thread::scope(|s| {
            files
                .chunks(chunk_size)
                .map(|chunk| s.spawn(move || scan_files(chunk, re_ref, generation)).join())
                .collect::<Vec<_>>()
        })
        .into_iter()
        .map(|joined| {
            joined
                .map_err(|_| "搜索线程异常退出".to_string())
                .and_then(|result| result)
        })
        .collect::<Result<Vec<(Vec<SearchHit>, bool)>, String>>()?;

        truncated = parts.iter().any(|(_, exceeded)| *exceeded)
            || parts
                .iter()
                .map(|(h, _)| h.len())
                .sum::<usize>()
                > MAX_TOTAL_HITS;

        // 按片序合并，只保留前 MAX_TOTAL_HITS 条，保证结果顺序确定（#163）
        for (part, _) in parts {
            if hits.len() >= MAX_TOTAL_HITS {
                break;
            }
            let remaining = MAX_TOTAL_HITS - hits.len();
            hits.extend(part.into_iter().take(remaining));
        }
    }

    Ok(SearchResult { hits, truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEST_DIR: AtomicUsize = AtomicUsize::new(0);

    /// 测试用代次：足够大，保证不受其它测试写入全局代次的影响
    const TEST_GENERATION: u64 = u64::MAX;

    /// 临时工作区，Drop 时自动清理
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
                "inklingmd-search-{label}-{}-{nonce}-{sequence}",
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

    fn write(path: &Path, content: &str) {
        fs::write(path, content).expect("write test file");
    }

    fn search(root: &Path, query: &str) -> SearchResult {
        search_in_workspace_sync(
            root.to_string_lossy().into_owned(),
            query.to_string(),
            true,
            false,
            TEST_GENERATION,
        )
        .expect("search should succeed")
    }

    #[test]
    fn empty_query_returns_empty() {
        let temp = TestDir::new("empty-query");
        write(&temp.path.join("a.md"), "hello world\n");

        let result = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            String::new(),
            true,
            false,
            TEST_GENERATION,
        )
        .unwrap();
        assert!(result.hits.is_empty());
        assert!(!result.truncated);
    }

    #[test]
    fn missing_workspace_returns_error() {
        let result = search_in_workspace_sync(
            "C:/definitely/not/a/real/workspace/path".to_string(),
            "x".to_string(),
            true,
            false,
            TEST_GENERATION,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("工作区不存在"));
    }

    #[test]
    fn case_sensitive_toggle() {
        let temp = TestDir::new("case");
        write(&temp.path.join("a.md"), "Hello\nhello\nHELLO\n");

        let sensitive = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            "hello".to_string(),
            true,
            false,
            TEST_GENERATION,
        )
        .unwrap();
        assert_eq!(sensitive.hits.len(), 1, "区分大小写只命中小写 hello");
        assert_eq!(sensitive.hits[0].line, 2);
        assert!(!sensitive.truncated);

        let insensitive = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            "hello".to_string(),
            false,
            false,
            TEST_GENERATION,
        )
        .unwrap();
        assert_eq!(insensitive.hits.len(), 3, "忽略大小写命中三种写法");
    }

    #[test]
    fn invalid_regex_returns_error() {
        let temp = TestDir::new("bad-regex");
        write(&temp.path.join("a.md"), "hello\n");

        let result = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            "(".to_string(),
            true,
            true,
            TEST_GENERATION,
        );
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("正则编译失败"));
    }

    #[test]
    fn line_and_path_correctness_across_files() {
        let temp = TestDir::new("multi-file");
        write(&temp.path.join("one.md"), "line one\nneedle here\nline three\n");
        write(&temp.path.join("two.md"), "no match\nneedle on second\n");
        write(&temp.path.join("three.md"), "needle first\n");

        let result = search(&temp.path, "needle");
        let hits = &result.hits;
        assert_eq!(hits.len(), 3);
        assert!(!result.truncated);

        // 按照返回顺序：文件收集顺序不固定，按路径断言各自的行号
        for hit in hits {
            let name = Path::new(&hit.path)
                .file_name()
                .unwrap()
                .to_string_lossy()
                .into_owned();
            match name.as_str() {
                "one.md" => assert_eq!(hit.line, 2),
                "two.md" => assert_eq!(hit.line, 2),
                "three.md" => assert_eq!(hit.line, 1),
                other => panic!("unexpected file {}", other),
            }
            // 完整路径应以工作区根为前缀
            assert!(hit.path.starts_with(&temp.path.to_string_lossy().into_owned()));
        }
    }

    #[test]
    fn hidden_directories_are_skipped() {
        let temp = TestDir::new("hidden");
        write(&temp.path.join("visible.md"), "needle\n");
        fs::create_dir(temp.path.join(".hidden")).unwrap();
        write(&temp.path.join(".hidden/a.md"), "needle\n");

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1, "隐藏目录中的文件不应被命中");
        assert!(!result.hits[0].path.contains(".hidden"));
    }

    #[test]
    fn non_utf8_file_is_skipped_silently() {
        let temp = TestDir::new("gbk");
        write(&temp.path.join("good.md"), "needle\n");
        // 写入一段非法 UTF-8 字节（GBK 编码的“你好世界”）
        let gbk: &[u8] = &[0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7];
        fs::write(temp.path.join("gbk.md"), gbk).unwrap();

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1, "非 UTF-8 文件应被静默跳过，不计命中也不 panic");
        assert_eq!(result.hits[0].line, 1);
    }

    #[test]
    fn column_counts_utf8_characters() {
        let temp = TestDir::new("column");
        // 中文（3 字节/字符）+ emoji（4 字节/字符）在前，needle 从第 2 个字符后开始
        write(&temp.path.join("a.md"), "你好😀needle\n");

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1);
        // needle 前有 3 个多字节字符（你、好、😀），列号从 1 开始 → 4
        assert_eq!(result.hits[0].column, 4);
    }

    #[test]
    fn plain_text_query_escapes_regex_metacharacters() {
        let temp = TestDir::new("escape");
        write(&temp.path.join("a.md"), "cost is 5.99\ncost is X99\n");

        // 纯文本模式下 "." 应被转义为字面量，只匹配 5.99
        let result = search(&temp.path, "5.99");
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].line, 1);
    }

    #[test]
    fn oversized_file_is_skipped() {
        let temp = TestDir::new("oversize");
        write(&temp.path.join("small.md"), "needle\n");
        // 写入超过 MAX_FILE_SIZE 的大文件
        let big_path = temp.path.join("big.md");
        let big = vec![b'x'; (MAX_FILE_SIZE + 1) as usize];
        fs::write(&big_path, big).unwrap();

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1, "超大文件应被跳过");
    }

    #[test]
    fn max_results_truncates_with_flag() {
        let temp = TestDir::new("max_results");
        let mut content = String::new();
        // 每行 10 个 needle，共 600 行 -> 6000 个匹配
        for _ in 0..600 {
            content.push_str("needle needle needle needle needle needle needle needle needle needle\n");
        }
        write(&temp.path.join("repeat.md"), &content);

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), MAX_TOTAL_HITS, "超过上限时应截断到 5000 条");
        assert!(result.truncated, "截断必须对前端可见（#160）");
    }

    #[test]
    fn truncation_across_files_keeps_sorted_order() {
        let temp = TestDir::new("truncate-multi");
        // 3 个文件 × 2000 条命中 = 6000 > 5000，覆盖跨分片合并截断路径
        for name in ["a.md", "b.md", "c.md"] {
            let content = "needle\n".repeat(2000);
            write(&temp.path.join(name), &content);
        }

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), MAX_TOTAL_HITS);
        assert!(result.truncated);
        // 合并按排序后的文件顺序：a.md 的 2000 条必须完整保留在前
        let a_count = result.hits.iter().filter(|h| h.path.ends_with("a.md")).count();
        assert_eq!(a_count, 2000, "截断应按文件排序顺序保留前部结果");
    }

    #[test]
    fn exactly_max_hits_is_not_truncated() {
        // 恰好 5000 条命中、无障碍提前退出，不应被误标为截断（评审 N-blocking）
        let temp = TestDir::new("exact-max");
        // 单文件恰好 MAX_TOTAL_HITS 条命中
        let content = "needle\n".repeat(MAX_TOTAL_HITS);
        write(&temp.path.join("a.md"), &content);

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), MAX_TOTAL_HITS);
        assert!(!result.truncated, "恰好 5000 条命中不应被标为截断");
    }

    #[test]
    fn preview_is_window_not_full_line() {
        let temp = TestDir::new("preview-window");
        // 模拟 base64 大图的超长单行：命中点两侧各 10 万字符填充（#176）
        let mut huge = "x".repeat(100_000);
        huge.push_str("needle");
        huge.push_str(&"y".repeat(100_000));
        write(&temp.path.join("img.md"), &format!("{}\n", huge));

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1);
        let preview = &result.hits[0].preview;
        assert!(preview.contains("needle"), "预览必须包含命中片段");
        assert!(
            preview.chars().count() <= PREVIEW_CONTEXT_CHARS * 2 + PREVIEW_MAX_MATCH_CHARS + 2,
            "预览应被窗口截断，实际 {} 字符",
            preview.chars().count()
        );
        assert!(preview.starts_with('…') && preview.ends_with('…'), "两侧截断应有省略号");
        assert!(
            !preview.contains(&"x".repeat(1000)),
            "预览不得克隆整行的长填充"
        );
    }

    #[test]
    fn preview_caps_huge_match_itself() {
        let temp = TestDir::new("preview-huge-match");
        // 5 万个 a 的单个超长匹配：命中片段本身也要封顶
        write(&temp.path.join("a.md"), &format!("{}\n", "a".repeat(50_000)));

        let result = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            "a+".to_string(),
            true,
            true,
            TEST_GENERATION,
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].column, 1);
        let preview = &result.hits[0].preview;
        assert!(
            preview.chars().count() <= PREVIEW_CONTEXT_CHARS * 2 + PREVIEW_MAX_MATCH_CHARS + 2,
            "超长匹配片段的预览也必须封顶，实际 {} 字符",
            preview.chars().count()
        );
    }

    #[test]
    fn preview_keeps_short_line_intact() {
        let temp = TestDir::new("preview-short");
        write(&temp.path.join("a.md"), "hello needle world\n");

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1);
        // 短行完整保留，不加省略号（前端高亮与跳转仍可在预览上重放正则）
        assert_eq!(result.hits[0].preview, "hello needle world");
    }

    #[test]
    fn generation_cancel_semantics() {
        // 两个场景都会写全局代次，必须在同一测试内顺序执行，避免并行测试互相干扰
        let temp = TestDir::new("cancel");
        write(&temp.path.join("a.md"), "needle\n");

        // 与 file_index 中同样写全局代次的用例互斥：写与断言之间存在窗口，
        // 并行跑时另一个测试 store 更大的值会把这里本该成功的调用判为过期（#227 复审 P2-1）
        let _generations = crate::commands::lock_generations();

        // 场景 1：更新的搜索（代次 7）已登记，旧任务（代次 6）必须立刻退出（#163）
        SEARCH_GENERATION.store(7, Ordering::Relaxed);
        let result = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            "needle".to_string(),
            true,
            false,
            6,
        );
        assert!(result.is_err(), "落后代次的搜索应被取消");
        assert!(result.unwrap_err().contains("取消"));

        // 场景 2：代次相等不算过期，当前搜索自己的代次就是全局最新
        SEARCH_GENERATION.store(3, Ordering::Relaxed);
        let result = search_in_workspace_sync(
            temp.path.to_string_lossy().into_owned(),
            "needle".to_string(),
            true,
            false,
            3,
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
    }

    #[test]
    fn newest_allocated_generation_is_never_starved() {
        // 多窗口场景回归（#241）：代次由 Rust 侧分配后，后发起的请求拿到更大代次并正常执行，
        // 不会被其它窗口更早的请求挤成「永久过期」。写全局代次，须与其它同类用例互斥。
        let _generations = crate::commands::lock_generations();

        let temp = TestDir::new("allocated-generation");
        write(&temp.path.join("a.md"), "needle\n");
        let root = temp.path.to_string_lossy().into_owned();

        // 归零后取代次，使断言不依赖其它用例留下的全局值（也避开 u64::MAX 绕回边界）
        SEARCH_GENERATION.store(0, Ordering::Relaxed);
        let token_a = crate::commands::next_generation(&SEARCH_GENERATION);
        let token_b = crate::commands::next_generation(&SEARCH_GENERATION);
        assert!(token_b > token_a, "后发起的请求必须拿到更大代次");

        // 更早窗口的请求（token_a）在 token_b 登记后按预期被取消
        let stale =
            search_in_workspace_sync(root.clone(), "needle".to_string(), true, false, token_a);
        assert!(stale.is_err(), "代次落后的搜索应被取消");
        assert!(stale.unwrap_err().contains("取消"));

        // 后开窗口的请求（token_b）自己就是全局最新——不再被饿死
        let fresh = search_in_workspace_sync(root, "needle".to_string(), true, false, token_b)
            .expect("最新代次的搜索必须成功");
        assert_eq!(fresh.hits.len(), 1);
    }

    #[test]
    fn single_file_search_and_nonexistent_workspace() {
        let temp = TestDir::new("single_file");
        let file = temp.path.join("only_one.md");
        write(&file, "target line here\n");

        // 搜索单文件路径
        let result = search_in_workspace_sync(
            file.to_string_lossy().to_string(),
            "target".into(),
            true,
            false,
            TEST_GENERATION,
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].line, 1);

        // 搜索不存在的路径
        let err = search_in_workspace_sync(
            temp.path.join("does_not_exist").to_string_lossy().to_string(),
            "target".into(),
            true,
            false,
            TEST_GENERATION,
        )
        .unwrap_err();
        assert!(err.contains("工作区不存在"));
    }

    #[test]
    fn ignore_node_modules_and_target_directories() {
        let temp = TestDir::new("ignore_dirs");
        let node_modules = temp.path.join("node_modules");
        let target = temp.path.join("target");
        let src = temp.path.join("src");
        fs::create_dir(&node_modules).unwrap();
        fs::create_dir(&target).unwrap();
        fs::create_dir(&src).unwrap();

        write(&node_modules.join("dep.md"), "needle in deps\n");
        write(&target.join("build.md"), "needle in target\n");
        write(&src.join("main.md"), "needle in src\n");

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1, "应跳过 node_modules 和 target 目录");
        assert!(result.hits[0].path.contains("src"));
    }

    #[test]
    fn search_stops_beyond_the_maximum_directory_depth() {
        // 深度上限的唯一定义在 ignore_rules（搜索与索引共用），此处直接引用来源符号
        use crate::commands::ignore_rules::MAX_SCAN_DIR_DEPTH;

        let temp = TestDir::new("max-depth");
        let mut current = temp.path.clone();
        for depth in 1..=MAX_SCAN_DIR_DEPTH + 1 {
            current = current.join(format!("level-{depth}"));
            fs::create_dir(&current).unwrap();
            if depth == MAX_SCAN_DIR_DEPTH {
                write(&current.join("included.md"), "needle\n");
            }
            if depth == MAX_SCAN_DIR_DEPTH + 1 {
                write(&current.join("excluded.md"), "needle\n");
            }
        }

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1);
        assert!(result.hits[0].path.ends_with("included.md"));
    }

    #[cfg(unix)]
    #[test]
    fn directory_symlink_self_loop_is_not_followed() {
        use std::os::unix::fs::symlink;
        let temp = TestDir::new("symlink-loop");
        write(&temp.path.join("visible.md"), "needle\n");
        symlink(&temp.path, temp.path.join("loop")).unwrap();

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1);
        assert!(result.hits[0].path.ends_with("visible.md"));
    }

    #[cfg(windows)]
    #[test]
    fn directory_symlink_self_loop_is_not_followed() {
        use std::process::Command;
        let temp = TestDir::new("symlink-loop");
        write(&temp.path.join("visible.md"), "needle\n");
        // Directory junctions are reparse points like directory symlinks but do
        // not require Windows Developer Mode or SeCreateSymbolicLinkPrivilege.
        let output = Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(temp.path.join("loop"))
            .arg(&temp.path)
            .output()
            .expect("cmd.exe should create a directory junction");
        assert!(
            output.status.success(),
            "failed to create junction: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let result = search(&temp.path, "needle");
        assert_eq!(result.hits.len(), 1);
        assert!(result.hits[0].path.ends_with("visible.md"));
    }
}
