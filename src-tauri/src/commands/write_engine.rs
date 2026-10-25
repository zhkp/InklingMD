// 文档 IO 契约（Epic #384 · B1 数据安全）
//
// PR-1（#362）只落地「成对读取」与命令错误契约；写盘引擎（`Fs`/`StdFs`/
// `atomic_write`/`TempKeptRegistry`）随 PR-2 追加到本模块，类型与错误分流以
// `tmp/write-engine-sketch.rs` 为准。
//
// 设计要点：
// * 内容与磁盘身份必须成对（同一次命令、同一句柄），否则「旧内容 + 新 stat」
//   会被当成基线，下次保存静默覆盖外部写入。
// * 错误码结构化（10 个，与前端 `src/lib/cmd-error.ts` 一一对应），不再用字符串
//   前缀匹配；非 UTF-8 仍保留可读文案（GBK/Big5 文件不能退化成通用 IO 错误）。

use serde::{Deserialize, Serialize};
use std::fs::{File, Metadata};
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

/// 打开上限（issue #159）：10MB，防止超大文件整体进内存并经 JSON IPC 传输。
pub const MAX_READ_SIZE: u64 = 10 * 1024 * 1024;

/// 文件磁盘身份：微秒级 mtime + 字节数。
///
/// 既是命令返回值，也是 `save_document(expected)` 的入参，所以必须同时
/// `Serialize` 与 `Deserialize`（只 Serialize 会在命令签名处编译失败）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub mtime_us: u64,
    pub size: u64,
}

/// 成对读取结果：`content` 与 `stat` 来自同一次打开/同一句柄的双检。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSnapshot {
    pub content: String,
    pub stat: FileStat,
}

/// 结构化错误码（本文件唯一副本；TS 侧 `CmdErrorCode` 必须一一对应）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // 契约全集：部分码由 PR-2 的写盘引擎与恢复通道使用
pub enum ErrorCode {
    NotFound,
    ParentMissing,
    PermissionDenied,
    ChangedDuringRead,
    FileTooLarge,
    EncodingUnsupported,
    InvalidArgument,
    Io,
    /// 1176/1177/Unknown：内容只在 temp 里（`CmdError.path` 指向该 temp）
    TempKept,
    /// 内容在 temp 里，但登记表写入失败 → 重启后可能找不到（必须强提示）
    TempRegisterFailed,
    /// 目标路径存在但不是普通文件（如同名目录占位）。
    /// 与 `file_mtime` / `write_text_file` 的 `NOT_A_FILE` 同语义（#391 已在前端立标）：
    /// 读到它不是「文件还在」，而是「原文档已不在原处」。
    NotAFile,
}

/// 命令异常。`CmdError` 是 struct，不能用 `serde(tag = ...)`（那只对 enum 有效）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmdError {
    pub code: ErrorCode,
    pub message: String,
    /// 内容所在（temp），非保存类错误为 None
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// 原目标路径，供 UI「另存为」
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
}

impl CmdError {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CmdError { code, message: message.into(), path: None, target: None }
    }
}

/// 按 ErrorKind 映射，不能让 NotFound / PermissionDenied 一律退化成 Io。
impl From<std::io::Error> for CmdError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => ErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
            _ => ErrorCode::Io,
        };
        CmdError::new(code, e.to_string())
    }
}

fn mtime_us(meta: &Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_micros() as u64)
        .unwrap_or(0)
}

fn stat_of(meta: &Metadata) -> FileStat {
    FileStat { mtime_us: mtime_us(meta), size: meta.len() }
}

/// 查询文件磁盘身份。缺失文件返回 `NotFound`（不是 `Io`）；
/// 路径被同名目录等非普通文件占据返回 `NotAFile`（与 `file_mtime` 的 `NOT_A_FILE` 同语义，
/// 否则 `switchTab` 会把「被目录占位」当成文件仍在原处）。
pub fn file_stat_sync(file_path: &str) -> Result<FileStat, CmdError> {
    let meta = std::fs::metadata(Path::new(file_path)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CmdError::new(ErrorCode::NotFound, format!("文件不存在: {file_path}"))
        } else {
            CmdError::from(e)
        }
    })?;
    if !meta.is_file() {
        return Err(CmdError::new(
            ErrorCode::NotAFile,
            format!("目标路径不是普通文件: {file_path}"),
        ));
    }
    Ok(stat_of(&meta))
}

/// 成对读取（#362 M0）。
///
/// 流程：`open → meta1 → 大小护栏 → 限额读取 → 解码 → meta2 → 双检`。
/// 同句柄保证「替换式更新」下内容与 stat 同源；同尺寸原地写仍可能撕裂，
/// 用 meta1/meta2 双检把概率压低（残余风险见设计 §13 R2），**绝不**把
/// 检测失败的 pair 交给调用方当基线。
pub fn read_document_sync(file_path: &str) -> Result<DocumentSnapshot, CmdError> {
    read_document_inner(file_path, || {})
}

/// `between_stats` 是双检之间的注入点：生产传空闭包，单测用它模拟
/// 「读取期间外部改写」以覆盖 `ChangedDuringRead` 分支。
fn read_document_inner<B: FnOnce()>(
    file_path: &str,
    between_stats: B,
) -> Result<DocumentSnapshot, CmdError> {
    let path = Path::new(file_path);
    let mut file = File::open(path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => {
            CmdError::new(ErrorCode::NotFound, format!("文件不存在: {file_path}"))
        }
        // 跨平台同码：Linux 能打开目录（随后由 meta1.is_file() 拦），Windows 打开目录
        // 直接 PermissionDenied —— 不在这里分诊的话，同一场景两平台会给出不同 code，
        // 前端就会把「被同名目录占位」当成权限错误（不进删除态）。
        _ if !std::fs::metadata(path).map(|m| m.is_file()).unwrap_or(true) => CmdError::new(
            ErrorCode::NotAFile,
            format!("目标路径不是普通文件: {file_path}"),
        ),
        _ => CmdError::from(e),
    })?;

    let meta1 = file.metadata().map_err(CmdError::from)?;
    // 目录在 Linux 上能被 `File::open` 打开，必须先拒绝非普通文件（否则读回空内容建出空 tab）
    if !meta1.is_file() {
        return Err(CmdError::new(
            ErrorCode::NotAFile,
            format!("目标路径不是普通文件: {file_path}"),
        ));
    }
    if meta1.len() > MAX_READ_SIZE {
        return Err(too_large(meta1.len()));
    }

    // 不能「先 len 判断再 read_to_end」：检查后文件继续增长会撑爆内存。
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_READ_SIZE + 1)
        .read_to_end(&mut bytes)
        .map_err(CmdError::from)?;
    if bytes.len() as u64 > MAX_READ_SIZE {
        return Err(too_large(bytes.len() as u64));
    }

    let content = String::from_utf8(bytes).map_err(|_| {
        CmdError::new(
            ErrorCode::EncodingUnsupported,
            format!("文件不是 UTF-8 编码（可能是 GBK/Big5 等旧编码），无法打开: {file_path}"),
        )
    })?;

    between_stats();

    let meta2 = file.metadata().map_err(CmdError::from)?;
    let (stat1, stat2) = (stat_of(&meta1), stat_of(&meta2));
    if stat1 != stat2 {
        return Err(CmdError::new(
            ErrorCode::ChangedDuringRead,
            format!(
                "文件在读取期间被修改（mtime {}→{}µs，大小 {}→{} 字节），请重试: {file_path}",
                stat1.mtime_us, stat2.mtime_us, stat1.size, stat2.size
            ),
        ));
    }

    Ok(DocumentSnapshot { content, stat: stat2 })
}

fn too_large(size: u64) -> CmdError {
    CmdError::new(
        ErrorCode::FileTooLarge,
        format!(
            "文件过大（{:.1} MB，超过 {} MB 打开上限），无法打开",
            size as f64 / (1024.0 * 1024.0),
            MAX_READ_SIZE / (1024 * 1024)
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::SystemTime;

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(0);

    struct TestDir {
        path: PathBuf,
    }

    impl TestDir {
        fn new(label: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system clock should be after Unix epoch")
                .as_nanos();
            let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "inklingmd-write-engine-{label}-{}-{nonce}-{seq}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("create test directory");
            Self { path }
        }

        fn file(&self, name: &str) -> String {
            self.path.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    // ── 成对读取 ──

    #[test]
    fn read_document_returns_content_and_stat_from_the_same_read() {
        let dir = TestDir::new("pair");
        let path = dir.file("doc.md");
        fs::write(&path, "# 标题\n正文").unwrap();

        let snap = read_document_sync(&path).unwrap();

        assert_eq!(snap.content, "# 标题\n正文");
        // stat 必须与磁盘真实状态一致（UTF-8 字节数，不是字符数）
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(snap.stat.size, meta.len());
        assert_eq!(snap.stat.size, "# 标题\n正文".as_bytes().len() as u64);
        assert!(snap.stat.mtime_us > 0);
        assert_eq!(snap.stat, stat_of(&meta));
    }

    #[test]
    fn read_document_detects_a_write_between_the_two_stats() {
        let dir = TestDir::new("changed");
        let path = dir.file("doc.md");
        fs::write(&path, "v1").unwrap();

        // 同一文件在 meta1 与 meta2 之间被外部改写：pair 已不可信
        let err = read_document_inner(&path, || {
            fs::write(&path, "v2-longer").unwrap();
        })
        .unwrap_err();

        assert_eq!(err.code, ErrorCode::ChangedDuringRead);
        assert!(err.message.contains("读取期间被修改"));
    }

    #[test]
    fn read_document_reports_not_found_for_a_missing_file() {
        let dir = TestDir::new("missing");
        let err = read_document_sync(&dir.file("nope.md")).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[test]
    fn read_document_reports_encoding_unsupported_for_non_utf8() {
        let dir = TestDir::new("encoding");
        let path = dir.file("gbk.md");
        // GBK 编码的「你好」：非合法 UTF-8
        fs::write(&path, [0xC4, 0xE3, 0xBA, 0xC3]).unwrap();

        let err = read_document_sync(&path).unwrap_err();
        assert_eq!(err.code, ErrorCode::EncodingUnsupported);
        // B8：结构化码之外必须保留可读文案，否则 GBK/Big5 文件退化成通用 IO 错误
        assert!(err.message.contains("不是 UTF-8 编码"));
        assert!(err.message.contains("GBK/Big5"));
    }

    #[test]
    fn read_document_rejects_files_above_the_limit_but_accepts_the_limit() {
        let dir = TestDir::new("size");

        let oversized = dir.file("oversized.md");
        fs::write(&oversized, vec![b'a'; MAX_READ_SIZE as usize + 1]).unwrap();
        let err = read_document_sync(&oversized).unwrap_err();
        assert_eq!(err.code, ErrorCode::FileTooLarge);

        let at_limit = dir.file("at-limit.md");
        fs::write(&at_limit, vec![b'b'; MAX_READ_SIZE as usize]).unwrap();
        let snap = read_document_sync(&at_limit).unwrap();
        assert_eq!(snap.content.len(), MAX_READ_SIZE as usize);
        assert_eq!(snap.stat.size, MAX_READ_SIZE);
    }

    #[test]
    fn file_stat_reports_size_and_microsecond_mtime() {
        let dir = TestDir::new("stat");
        let path = dir.file("doc.md");
        fs::write(&path, "abc").unwrap();

        let stat = file_stat_sync(&path).unwrap();
        assert_eq!(stat.size, 3);
        // 微秒精度：与毫秒换算后不得为 0（防止把 µs 写成 ms）
        assert!(stat.mtime_us / 1000 > 1_700_000_000_000);
    }

    #[test]
    fn file_stat_distinguishes_missing_file_from_io_error() {
        let dir = TestDir::new("stat-missing");
        let err = file_stat_sync(&dir.file("nope.md")).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.path.is_none());
        assert!(err.target.is_none());
    }

    /// 同名目录占位：不是「文件仍在」，必须给 `NotAFile`（与 `file_mtime` 的 `NOT_A_FILE` 同语义）。
    /// 若这里退化成 Ok，`switchTab` 会认为文档还在原处，删除态永远建不起来。
    #[test]
    fn file_stat_and_read_document_reject_directory_at_document_path() {
        let dir = TestDir::new("stat-not-a-file");
        let occupied = dir.path.join("doc.md");
        fs::create_dir(&occupied).unwrap();

        let stat_err = file_stat_sync(&occupied.to_string_lossy()).unwrap_err();
        assert_eq!(stat_err.code, ErrorCode::NotAFile);

        let read_err = read_document_sync(&occupied.to_string_lossy()).unwrap_err();
        assert_eq!(read_err.code, ErrorCode::NotAFile);
        // 目录不得被当成空文档返回（那会开出一个空 tab 覆盖用户认知）
        assert_eq!(
            serde_json::to_value(&stat_err).unwrap()["code"],
            serde_json::Value::String("notAFile".into())
        );
    }

    // ── 序列化契约（与前端唯一对应） ──

    #[test]
    fn file_stat_round_trips_through_camel_case_json() {
        let stat = FileStat { mtime_us: 1_700_000_000_123_456, size: 42 };
        let json = serde_json::to_value(stat).unwrap();
        assert_eq!(json["mtimeUs"], 1_700_000_000_123_456u64);
        assert_eq!(json["size"], 42);
        // expected 是命令入参：必须能反序列化回来
        let back: FileStat = serde_json::from_value(json).unwrap();
        assert_eq!(back, stat);
    }

    #[test]
    fn document_snapshot_serializes_content_with_nested_stat() {
        let snap = DocumentSnapshot {
            content: "hello".into(),
            stat: FileStat { mtime_us: 7, size: 5 },
        };
        let json = serde_json::to_value(&snap).unwrap();
        assert_eq!(json["content"], "hello");
        assert_eq!(json["stat"]["mtimeUs"], 7);
        assert_eq!(json["stat"]["size"], 5);
    }

    #[test]
    fn cmd_error_serializes_code_as_camel_case_and_skips_empty_options() {
        let err = CmdError::new(ErrorCode::EncodingUnsupported, "无法打开");
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["code"], "encodingUnsupported");
        assert_eq!(json["message"], "无法打开");
        assert!(json.get("path").is_none(), "path 为 None 时不得序列化成 null");
        assert!(json.get("target").is_none());

        let with_temp = CmdError {
            code: ErrorCode::TempKept,
            message: "内容保留在临时文件".into(),
            path: Some("/d/a.tmp".into()),
            target: Some("/d/a.md".into()),
        };
        let json = serde_json::to_value(&with_temp).unwrap();
        assert_eq!(json["code"], "tempKept");
        assert_eq!(json["path"], "/d/a.tmp");
        assert_eq!(json["target"], "/d/a.md");
    }

    #[test]
    fn io_error_kind_maps_to_structured_codes() {
        let not_found = CmdError::from(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert_eq!(not_found.code, ErrorCode::NotFound);
        let denied = CmdError::from(std::io::Error::from(std::io::ErrorKind::PermissionDenied));
        assert_eq!(denied.code, ErrorCode::PermissionDenied);
        let other = CmdError::from(std::io::Error::other("boom"));
        assert_eq!(other.code, ErrorCode::Io);
    }
}
