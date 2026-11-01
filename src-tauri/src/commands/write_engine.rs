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
use std::path::{Path, PathBuf};
use std::sync::Mutex;
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
#[allow(dead_code)] // 契约全集：部分码仅测试辅助函数构造 / 留给恢复通道
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
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CmdError { code, message: message.into(), path: None, target: None }
    }

    /// 半失败：内容只在 temp 里，UI 必须带 temp 路径提示「另存为」。
    pub fn temp_kept(temp: &Path, target: &Path, message: impl Into<String>) -> Self {
        CmdError {
            code: ErrorCode::TempKept,
            message: message.into(),
            path: Some(temp.display().to_string()),
            target: Some(target.display().to_string()),
        }
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

/// 提交语义三态：用一个 bool 表达会直接把「导出覆盖 / 保存已有 / 另存为未确认覆盖」做坏。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitMode {
    /// 允许创建、允许覆盖：导出 HTML/MD、资源写入、用户已在保存对话框确认覆盖的另存为
    CreateOrReplace,
    /// 目标必须存在：命名文档保存（目标消失 → NotFound，绝不复活）
    ReplaceExisting,
    /// 目标必须不存在：未确认覆盖的编程式另存为（目标出现 → AlreadyExists → Conflict）
    CreateExclusive,
}

/// 平台替换原语的失败分类：1175/1176/1177 与 Unsupported/Unknown 必须分开处理，
/// 否则「1176 移回」会替前端做「是否复活旧路径」的决定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaceError {
    NotFound,
    AlreadyExists,
    /// 1176：替换文件移动失败，**目标与 temp 的实际状态未定**，必须 probe 后决定
    ReplacementMoveFailed,
    /// 1177（两边都还在）
    PartialState,
    /// 本平台/本卷不支持该原语 → `platform_commit` 内部回退
    Unsupported,
    /// 未识别：目标状态未知
    UnknownTargetState,
    /// 1175：目标未变
    Other,
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SaveOutcome {
    Written { stat: FileStat, foreign_write: bool },
    Conflict {
        disk: FileStat,
        /// 必须 skip 掉 None：否则 TS 侧 `tempPath?: string` 会收到 `null`
        #[serde(skip_serializing_if = "Option::is_none")]
        temp_path: Option<String>,
        register_failed: bool,
    },
    NotFound,
    ParentMissing { parent: String },
    /// 父路径被同名**文件**占用（不是「目录不存在」）：补建目录必然失败，
    /// UI 不能提供「重新创建」，只能另存为
    ParentNotDir { parent: String },
}

#[derive(Debug)]
pub enum AtomicError {
    Outcome(SaveOutcome),
    Cmd(CmdError),
}

impl From<CmdError> for AtomicError {
    fn from(e: CmdError) -> Self {
        AtomicError::Cmd(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReceipt {
    pub stat: FileStat,
    pub foreign_write: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptPolicy {
    MtimeAndSize,
    ReadBack,
}

// 回执策略只由 `receipt_policy()` 决定（不设同名常量，避免两处真值源）

pub trait Fs {
    /// 入参是**目标文件路径**（不是父目录）：实现内部要自己取 `path.parent()`。
    /// 错当成「传父目录」会让所有保存在真实 FS 上直接 ParentMissing。
    fn parent_exists(&self, path: &Path) -> std::io::Result<bool>;
    fn create_parent_dirs(&self, path: &Path) -> std::io::Result<()>;
    fn stat(&self, path: &Path) -> std::io::Result<Option<FileStat>>;
    fn write_temp(&self, target: &Path, content: &str) -> std::io::Result<(PathBuf, FileStat)>;
    fn sync_temp(&self, temp: &Path) -> std::io::Result<()>;
    fn sync_parent(&self, target: &Path) -> std::io::Result<()>;
    fn read_text(&self, path: &Path) -> std::io::Result<String>;
    fn remove_temp(&self, temp: &Path);
    fn sleep_ms(&self, ms: u64);
}

pub trait TempKeptStore {
    fn register(&self, temp: &Path, target: &Path) -> Result<(), CmdError>;
    /// 半失败（1176/1177 不匹配/Unknown）时是否登记为"唯一副本"。
    /// recovery 写入（journal/session/crashed）用 Never：那是缓存，内存里还有，
    /// 登记只会造出假的"用户文档唯一副本"并让 TTL 留下悬空条目。
    fn register_policy(&self) -> RegisterPolicy {
        RegisterPolicy::OnFailure
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegisterPolicy {
    OnFailure,
    Never,
}

/// recovery/ 专用：任何半失败都删 temp + Io，不登记
#[cfg(test)]
pub struct NoRegisterStore;

#[cfg(test)]
impl NoRegisterStore {
    /// 断言用：Never 策略下任何半失败都不登记
    pub fn entries(&self) -> Vec<TempKeptEntry> {
        vec![]
    }
}
#[cfg(test)]
impl TempKeptStore for NoRegisterStore {
    fn register(&self, _t: &Path, _g: &Path) -> Result<(), CmdError> {
        unreachable!("Never policy 不走 register")
    }
    fn register_policy(&self) -> RegisterPolicy {
        RegisterPolicy::Never
    }
}

/// 持久化 DTO：字段名即 temp-kept.json 的键名（serde camelCase），
/// 所以用 String 而不是 PathBuf——与 TS 的 tempPath/targetPath 唯一对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TempKeptEntry {
    pub temp_path: String,
    pub target_path: String,
    pub created_at: u64,
}

/// `recovery/temp-kept.json` 的顶层结构；`version` 便于以后迁移。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TempKeptFile {
    pub version: u32,
    pub entries: Vec<TempKeptEntry>,
}

/// 真实实现：Mutex 串行化 read-modify-write（同窗口多个 spawn_blocking 会并发）
#[cfg(test)]
pub struct MutexTempKeptStore {
    entries: Mutex<Vec<TempKeptEntry>>,
    fail: bool,
}
#[cfg(test)]
impl MutexTempKeptStore {
    pub fn new(fail: bool) -> Self {
        MutexTempKeptStore { entries: Mutex::new(vec![]), fail }
    }

    /// 断言用：读取当前登记表（生产走 `TempKeptRegistry::prune_missing` 的整表 retain）
    pub fn entries(&self) -> Vec<TempKeptEntry> {
        self.entries.lock().unwrap().clone()
    }
}
#[cfg(test)]
impl TempKeptStore for MutexTempKeptStore {
    fn register(&self, temp: &Path, target: &Path) -> Result<(), CmdError> {
        if self.fail {
            return Err(CmdError {
                code: ErrorCode::Io,
                message: "registry write failed".into(),
                path: None,
                target: None,
            });
        }
        let ts = temp.display().to_string();
        let mut g = self.entries.lock().unwrap();
        if !g.iter().any(|e| e.temp_path == ts) {
            g.push(TempKeptEntry {
                temp_path: ts,
                target_path: target.display().to_string(),
                created_at: 0,
            });
        }
        Ok(())
    }
}

pub const MAX_ATTEMPTS: u32 = 5;
pub const RETRY_DELAY_MS: u64 = 50;

fn receipt_for<F: Fs>(
    fs: &F,
    target: &Path,
    temp_meta: FileStat,
    policy: ReceiptPolicy,
    content: &str,
) -> Result<WriteReceipt, AtomicError> {
    let stat = match fs.stat(target) {
        Ok(v) => v,
        Err(_) => match fs.stat(target) {
            Ok(v) => v,
            Err(_) => return Ok(WriteReceipt { stat: temp_meta, foreign_write: true }),
        },
    };
    let post = match stat {
        Some(s) => s,
        None => return Err(AtomicError::Outcome(SaveOutcome::NotFound)),
    };
    let foreign_write = match policy {
        ReceiptPolicy::MtimeAndSize => post != temp_meta,
        ReceiptPolicy::ReadBack => fs.read_text(target).map(|t| t != content).unwrap_or(true),
    };
    Ok(WriteReceipt { stat: post, foreign_write })
}

/// 保留 temp（可能是唯一副本）并返回可操作错误；register 失败也必须带 temp_path。
/// 若 store 的 policy 是 Never（recovery 写入），则删 temp + Io，绝不登记。
fn keep<F: Fs, S: TempKeptStore>(
    fs: &F,
    store: &S,
    temp: &Path,
    target: &Path,
    disk: Option<FileStat>,
    message: &str,
) -> AtomicError {
    if store.register_policy() == RegisterPolicy::Never {
        fs.remove_temp(temp);
        return AtomicError::Cmd(CmdError {
            code: ErrorCode::Io,
            message: format!("{}（临时文件已丢弃）", message),
            path: None,
            target: Some(target.display().to_string()),
        });
    }
    let temp_s = temp.display().to_string();
    match store.register(temp, target) {
        Ok(()) => match disk {
            Some(d) => AtomicError::Outcome(SaveOutcome::Conflict {
                disk: d,
                temp_path: Some(temp_s),
                register_failed: false,
            }),
            None => AtomicError::Cmd(CmdError {
                code: ErrorCode::TempKept,
                message: message.into(),
                path: Some(temp_s),
                target: Some(target.display().to_string()),
            }),
        },
        Err(e) => match disk {
            // 登记失败也要给 temp_path，否则 UI 与清理器都看不到唯一副本
            Some(d) => AtomicError::Outcome(SaveOutcome::Conflict {
                disk: d,
                temp_path: Some(temp_s),
                register_failed: true,
            }),
            None => AtomicError::Cmd(CmdError {
                code: ErrorCode::TempRegisterFailed,
                message: format!("{}；且登记失败（重启后可能找不到）：{}", message, e.message),
                path: Some(temp_s),
                target: Some(target.display().to_string()),
            }),
        },
    }
}

/// 唯一出口：根据"temp 是否可能是唯一副本"决定删还是留
#[allow(clippy::too_many_arguments)]
fn settle<F: Fs, S: TempKeptStore>(
    fs: &F,
    store: &S,
    temp: &Path,
    target: &Path,
    temp_may_be_only_copy: bool,
    // 非粘性场景下的"确定性失败"如何表达
    deterministic: Deterministic,
) -> AtomicError {
    if !temp_may_be_only_copy {
        fs.remove_temp(temp);
        return match deterministic {
            Deterministic::NotFound => AtomicError::Outcome(SaveOutcome::NotFound),
            Deterministic::Conflict(disk) => AtomicError::Outcome(SaveOutcome::Conflict {
                disk,
                temp_path: None,
                register_failed: false,
            }),
            Deterministic::Io(msg) => AtomicError::Cmd(CmdError {
                code: ErrorCode::Io,
                message: msg,
                path: None,                                    // path 只放"内容所在 temp"
                target: Some(target.display().to_string()),
            }),
        };
    }
    // 三态：stat 的 Err 不得当成"不存在"
    match probe(fs, target) {
        Probe::Present(d) => keep(fs, store, temp, target, Some(d), "内容保留在临时文件（目标状态不确定）"),
        Probe::Absent | Probe::Unknown => {
            keep(fs, store, temp, target, None, "内容保留在临时文件（目标状态不确定）")
        }
    }
}

enum Deterministic {
    NotFound,
    Conflict(FileStat),
    Io(String),
}

/// 耐久策略：None 用于「丢了能重做」的写入（导出 / 备份副本等，不 fsync），
/// 用户文档保存用 Sync（temp + 父目录都落盘）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Durability {
    None,
    Sync,
}

#[allow(clippy::too_many_arguments)]
pub fn atomic_write<F, P, C, S>(
    fs: &F,
    path: &Path,
    content: &str,
    create_parent_dirs: bool,
    mode: CommitMode,
    policy: ReceiptPolicy,
    durability: Durability,
    mut on_before_commit: P,
    mut commit: C,
    store: &S,
) -> Result<WriteReceipt, AtomicError>
where
    F: Fs,
    P: FnMut(&Path) -> Result<(), AtomicError>,
    C: FnMut(CommitMode, &Path, &Path) -> Result<(), ReplaceError>,
    S: TempKeptStore,
{
    if !fs.parent_exists(path).map_err(CmdError::from)? {
        if mode == CommitMode::ReplaceExisting || !create_parent_dirs {
            return Err(AtomicError::Outcome(SaveOutcome::ParentMissing {
                parent: path.parent().map(|p| p.display().to_string()).unwrap_or_default(),
            }));
        }
        fs.create_parent_dirs(path).map_err(CmdError::from)?;
    }

    let (temp, temp_meta) = fs.write_temp(path, content).map_err(CmdError::from)?;
    if durability == Durability::Sync {
        if let Err(e) = fs.sync_temp(&temp) {
            fs.remove_temp(&temp);
            return Err(AtomicError::Cmd(e.into()));
        }
    }

    // 粘性：一旦无法确定目标状态，之后任何出口都不许删 temp
    let mut temp_may_be_only_copy = false;

    for attempt in 0..MAX_ATTEMPTS {
        if attempt > 0 {
            fs.sleep_ms(RETRY_DELAY_MS);
        }
        if let Err(e) = on_before_commit(path) {
            return Err(if temp_may_be_only_copy {
                match e {
                    AtomicError::Outcome(SaveOutcome::Conflict { disk, .. }) => {
                        keep(fs, store, &temp, path, Some(disk), "复核发现冲突")
                    }
                    // 三态：stat Err 不当作"目标不存在"
                    _ => match probe(fs, path) {
                        Probe::Present(d) => keep(fs, store, &temp, path, Some(d), "复核失败"),
                        Probe::Absent | Probe::Unknown => keep(fs, store, &temp, path, None, "复核失败"),
                    },
                }
            } else {
                fs.remove_temp(&temp);
                e
            });
        }

        match commit(mode, &temp, path) {
            Ok(()) => {
                // 提交成功必须自己清 temp：POSIX 的 `RENAME_EXCHANGE` 是把旧目标换到
                // temp 路径上（不是"消耗 temp"），不删就会在文档目录里留下 `.<name>.tmp.*`。
                // Windows 的 ReplaceFileW / MoveFileEx 已消耗 temp，这里是幂等 no-op。
                fs.remove_temp(&temp);
                let r = receipt_for(fs, path, temp_meta, policy, content)?;
                // Durability::None 不做任何 fsync；Sync 才落盘父目录
                if durability == Durability::Sync {
                    let _ = fs.sync_parent(path);
                }
                return Ok(r);
            }
            Err(ReplaceError::NotFound) => {
                return Err(settle(fs, store, &temp, path, temp_may_be_only_copy, Deterministic::NotFound));
            }
            Err(ReplaceError::AlreadyExists) => match fs.stat(path) {
                Ok(Some(disk)) => {
                    return Err(settle(
                        fs, store, &temp, path, temp_may_be_only_copy, Deterministic::Conflict(disk),
                    ));
                }
                // 拿不到目标 stat（闪现/IO）→ 无法证明 temp 不是唯一副本
                Ok(None) | Err(_) => {
                    temp_may_be_only_copy = true;
                    continue;
                }
            },
            // 1176：**一律不移回**。Rust 不知道前端是否有 tombstone（重命名/删除事件只在前端），
            // 若在这里 CreateExclusive 把 temp 搬回旧路径，就会在"保存期间被改名/删除"时复活旧路径（#363）。
            // 因此只做：probe 两侧 → 保留 temp + 登记 + 上报，由前端决定是否另存。
            Err(ReplaceError::ReplacementMoveFailed) => {
                return Err(replacement_failed(fs, store, &temp, path));
            }
            Err(ReplaceError::PartialState) => match fs.stat(path) {
                Ok(Some(disk)) if disk == temp_meta => {
                    if durability == Durability::Sync {
                        let _ = fs.sync_parent(path);
                    }
                    return Ok(WriteReceipt { stat: disk, foreign_write: false });
                }
                Ok(Some(disk)) => {
                    return Err(keep(fs, store, &temp, path, Some(disk), "替换处于半失败态"));
                }
                Ok(None) => {
                    // 目标不存在：等同 1176 的"目标缺失"现实，同样不移回
                    return Err(replacement_failed(fs, store, &temp, path));
                }
                Err(_) => {
                    temp_may_be_only_copy = true;
                    continue;
                }
            },
            Err(ReplaceError::UnknownTargetState) => {
                temp_may_be_only_copy = true;
                continue;
            }
            // 原语不支持（EINVAL/ENOSYS/ENOTSUP/EXDEV）→ 可重试，且**不得**置位粘性标志
            Err(ReplaceError::Unsupported) => continue,
            Err(ReplaceError::Other) => continue,
        }
    }

    Err(settle(
        fs,
        store,
        &temp,
        path,
        temp_may_be_only_copy,
        Deterministic::Io(format!("提交重试 {} 次仍失败", MAX_ATTEMPTS)),
    ))
}

/// 1176（替换文件移动失败）：**不做任何"移回"**，只按两侧实际状态上报。
/// 移回会把旧路径重新创建出来，而"旧路径是否允许复活"只有前端知道（tombstone），Rust 无权决定。
fn replacement_failed<F: Fs, S: TempKeptStore>(
    fs: &F,
    store: &S,
    temp: &Path,
    target: &Path,
) -> AtomicError {
    match (probe(fs, temp), probe(fs, target)) {
        // temp 仍在：目标存在 → 冲突（带 temp）；否则 → 唯一副本在 temp
        (Probe::Present(_), Probe::Present(d)) => {
            keep(fs, store, temp, target, Some(d), "替换失败，目标是外部内容")
        }
        (Probe::Present(_), Probe::Absent) => {
            keep(fs, store, temp, target, None, "替换失败，目标不存在，唯一副本在临时文件")
        }
        (Probe::Present(_), Probe::Unknown) => {
            keep(fs, store, temp, target, None, "替换失败，目标状态未知，唯一副本在临时文件")
        }
        // temp 状态未知：可能还在 → 必须保留，绝不返回成功
        (Probe::Unknown, Probe::Present(d)) => {
            keep(fs, store, temp, target, Some(d), "替换失败，临时文件状态未知")
        }
        (Probe::Unknown, Probe::Absent | Probe::Unknown) => {
            keep(fs, store, temp, target, None, "替换失败，临时文件状态未知")
        }
        // temp 已不在、目标在：无法确认目标是不是我们写的 → 交给用户判断，不谎报成功
        (Probe::Absent, Probe::Present(d)) => AtomicError::Outcome(SaveOutcome::Conflict {
            disk: d,
            temp_path: None,
            register_failed: false,
        }),
        (Probe::Absent, Probe::Absent) => AtomicError::Cmd(CmdError {
            code: ErrorCode::Io,
            message: "替换失败，且临时文件与目标均不存在".into(),
            path: None,
            target: Some(target.display().to_string()),
        }),
        (Probe::Absent, Probe::Unknown) => AtomicError::Cmd(CmdError {
            code: ErrorCode::Io,
            message: "替换失败，临时文件已不在且目标状态未知".into(),
            path: None,
            target: Some(target.display().to_string()),
        }),
    }
}

/// stat 三态：Err 一律当"未知"，绝不当"不存在"
enum Probe {
    Present(FileStat),
    Absent,
    Unknown,
}

fn probe<F: Fs>(fs: &F, p: &Path) -> Probe {
    match fs.stat(p) {
        Ok(Some(s)) => Probe::Present(s),
        Ok(None) => Probe::Absent,
        Err(_) => Probe::Unknown,
    }
}

/// 旧写盘入口（导出/备份用）：必须共享同一个登记表，否则 1176 会留下未登记孤儿
#[cfg(test)]
pub fn write_text_file_sync<F, C, S>(
    fs: &F,
    path: &Path,
    content: &str,
    commit: C,
    store: &S,
) -> Result<(), CmdError>
where
    F: Fs,
    C: FnMut(CommitMode, &Path, &Path) -> Result<(), ReplaceError>,
    S: TempKeptStore,
{
    match atomic_write(fs, path, content, true, CommitMode::CreateOrReplace,
                       receipt_policy(), Durability::Sync, |_p| Ok(()), commit, store) {
        Ok(_) => Ok(()),
        Err(AtomicError::Cmd(e)) => Err(e),
        // CreateOrReplace 也可能撞上半失败态：必须转成结构化错误，带上 temp/target
        Err(AtomicError::Outcome(SaveOutcome::Conflict { temp_path: Some(t), register_failed, .. })) => {
            Err(CmdError {
                code: if register_failed { ErrorCode::TempRegisterFailed } else { ErrorCode::TempKept },
                message: "目标处于半失败态，内容保留在临时文件".into(),
                path: Some(t),
                target: Some(path.display().to_string()),
            })
        }
        Err(AtomicError::Outcome(SaveOutcome::Conflict { temp_path: None, .. })) => Err(CmdError {
            code: ErrorCode::Io,
            message: "目标已存在且内容不同".into(),
            path: None,
            target: Some(path.display().to_string()),
        }),
        Err(AtomicError::Outcome(SaveOutcome::NotFound)) => Err(CmdError {
            code: ErrorCode::Io,
            message: "目标消失".into(),
            path: None,
            target: Some(path.display().to_string()),
        }),
        Err(AtomicError::Outcome(SaveOutcome::ParentNotDir { parent })) => Err(CmdError {
            code: ErrorCode::NotAFile,
            message: format!("父路径被文件占用：{}", parent),
            path: None,
            target: Some(path.display().to_string()),
        }),
        Err(AtomicError::Outcome(SaveOutcome::ParentMissing { parent })) => Err(CmdError {
            code: ErrorCode::ParentMissing,
            message: format!("父目录不存在：{}", parent),
            path: None,
            target: Some(path.display().to_string()),
        }),
        Err(AtomicError::Outcome(SaveOutcome::Written { .. })) => Err(CmdError {
            code: ErrorCode::Io,
            message: "内部错误：CreateOrReplace 返回了 Written".into(),
            path: None,
            target: Some(path.display().to_string()),
        }),
    }
}

/// 生产回执策略：证明平台保留 mtime 之前一律 ReadBack
pub fn receipt_policy() -> ReceiptPolicy {
    ReceiptPolicy::ReadBack
}

/// 公开测试入口：只做 mode 映射 + atomic_write。
/// 注意：`atomic_write` **会**做写后回执（receipt_for），本函数只是不做 §5.2 ② 的 initial stat。
#[allow(clippy::too_many_arguments)]
#[cfg(test)]
pub fn write_document_with<F, P, C, S>(
    fs: &F,
    file_path: &Path,
    content: &str,
    expected: Option<FileStat>,
    create_parent_dirs: bool,
    overwrite_existing: bool,
    policy: ReceiptPolicy,
    on_before_commit: P,
    commit: C,
    store: &S,
) -> Result<SaveOutcome, CmdError>
where
    F: Fs,
    P: FnMut(&Path) -> Result<(), AtomicError>,
    C: FnMut(CommitMode, &Path, &Path) -> Result<(), ReplaceError>,
    S: TempKeptStore,
{
    let mode = match (expected, overwrite_existing) {
        (Some(_), _) => CommitMode::ReplaceExisting,
        (None, true) => CommitMode::CreateOrReplace,
        (None, false) => CommitMode::CreateExclusive,
    };
    if expected.is_some() && create_parent_dirs {
        return Err(CmdError {
            code: ErrorCode::InvalidArgument,
            message: "既有文档保存不得创建父目录".into(),
            path: None,
            target: Some(file_path.display().to_string()),
        });
    }
    match atomic_write(fs, file_path, content, create_parent_dirs, mode, policy, Durability::Sync,
                       on_before_commit, commit, store) {
        Ok(r) => Ok(SaveOutcome::Written { stat: r.stat, foreign_write: r.foreign_write }),
        Err(AtomicError::Outcome(o)) => Ok(o),
        Err(AtomicError::Cmd(e)) => Err(e),
    }
}

// ─────────────────────────── tests ───────────────────────────

// ── 生产实现：StdFs / platform_commit / TempKeptRegistry ─────────────────────

/// 真实文件系统：`std::fs` + 平台替换原语。
///
/// 耐久策略由调用方决定：`write_temp` 只写不 fsync，`sync_temp` / `sync_parent`
/// 只在 `Durability::Sync` 时被 `atomic_write` 调用（`None` 的写入不落盘）。
pub struct StdFs;

static TEMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl Fs for StdFs {
    fn parent_exists(&self, path: &Path) -> std::io::Result<bool> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        match std::fs::metadata(parent) {
            Ok(meta) => Ok(meta.is_dir()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e),
        }
    }

    fn create_parent_dirs(&self, path: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(path)
    }

    fn stat(&self, path: &Path) -> std::io::Result<Option<FileStat>> {
        match std::fs::metadata(path) {
            // 目录/设备等非普通文件按「不可作为文档目标」处理，上层据此报 NotAFile / Conflict
            Ok(meta) if !meta.is_file() => Ok(None),
            Ok(meta) => Ok(Some(stat_of(&meta))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn write_temp(&self, target: &Path, content: &str) -> std::io::Result<(PathBuf, FileStat)> {
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        let name = target
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("document");
        let seq = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp = parent.join(format!(".{name}.tmp.{}-{seq}", std::process::id()));
        let mut file = File::create(&temp)?;
        use std::io::Write;
        if let Err(e) = file.write_all(content.as_bytes()) {
            let _ = std::fs::remove_file(&temp);
            return Err(e);
        }
        let meta = file.metadata()?;
        Ok((temp, stat_of(&meta)))
    }

    fn sync_temp(&self, temp: &Path) -> std::io::Result<()> {
        // 必须带写权限：Windows 上对只读句柄调用 FlushFileBuffers 直接 ACCESS_DENIED，
        // 会让每次 Durability::Sync 的保存都失败
        std::fs::OpenOptions::new()
            .write(true)
            .open(temp)?
            .sync_all()
    }

    fn sync_parent(&self, target: &Path) -> std::io::Result<()> {
        #[cfg(unix)]
        {
            // 目录 fsync 才能保证「改名」本身落盘；Windows 无对应语义（见设计 R3b）
            if let Some(parent) = target.parent() {
                if !parent.as_os_str().is_empty() {
                    File::open(parent)?.sync_all()?;
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = target;
        }
        Ok(())
    }

    fn read_text(&self, path: &Path) -> std::io::Result<String> {
        std::fs::read_to_string(path)
    }

    fn remove_temp(&self, temp: &Path) {
        let _ = std::fs::remove_file(temp);
    }

    fn sleep_ms(&self, ms: u64) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

// 回执策略见上文 `receipt_policy()`：统一用 `ReadBack`（读回比对内容），
// 不依赖「替换后 mtime == temp mtime」这一平台假设。

// ── 平台替换原语 ────────────────────────────────────────────────────────────

#[cfg(windows)]
pub fn platform_commit(mode: CommitMode, temp: &Path, target: &Path) -> Result<(), ReplaceError> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    extern "system" {
        fn ReplaceFileW(
            replaced: *const u16,
            replacement: *const u16,
            backup: *const u16,
            flags: u32,
            exclude: usize,
            reserved: usize,
        ) -> i32;
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;

    fn wide(path: &Path) -> Vec<u16> {
        OsStr::new(path).encode_wide().chain(std::iter::once(0)).collect()
    }
    fn last_err() -> i32 {
        std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
    }

    let (t, g) = (wide(temp), wide(target));
    match mode {
        CommitMode::ReplaceExisting => {
            // ReplaceFileW 要求目标已存在；失败码 1175/1176/1177 必须分开（三态未定）
            let ok = unsafe { ReplaceFileW(g.as_ptr(), t.as_ptr(), std::ptr::null(), 0, 0, 0) };
            if ok != 0 {
                return Ok(());
            }
            match last_err() {
                2 | 3 => Err(ReplaceError::NotFound),   // ERROR_FILE_NOT_FOUND / PATH_NOT_FOUND
                1175 => Err(ReplaceError::Other),
                1176 => Err(ReplaceError::ReplacementMoveFailed),
                1177 => Err(ReplaceError::PartialState),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
        CommitMode::CreateOrReplace => {
            let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
            let ok = unsafe { MoveFileExW(t.as_ptr(), g.as_ptr(), flags) };
            if ok != 0 {
                return Ok(());
            }
            match last_err() {
                2 | 3 => Err(ReplaceError::NotFound),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
        CommitMode::CreateExclusive => {
            // 不带 REPLACE_EXISTING：目标已存在 → ERROR_ALREADY_EXISTS(183) / ERROR_FILE_EXISTS(80)
            let ok = unsafe { MoveFileExW(t.as_ptr(), g.as_ptr(), MOVEFILE_WRITE_THROUGH) };
            if ok != 0 {
                return Ok(());
            }
            match last_err() {
                80 | 183 => Err(ReplaceError::AlreadyExists),
                2 | 3 => Err(ReplaceError::NotFound),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
    }
}

#[cfg(target_os = "linux")]
pub fn platform_commit(mode: CommitMode, temp: &Path, target: &Path) -> Result<(), ReplaceError> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn renameat2(
            olddirfd: c_int,
            oldpath: *const c_char,
            newdirfd: c_int,
            newpath: *const c_char,
            flags: c_uint,
        ) -> c_int;
    }
    const AT_FDCWD: c_int = -100;
    const RENAME_NOREPLACE: c_uint = 1;
    const RENAME_EXCHANGE: c_uint = 2;
    const EINVAL: i32 = 22;
    const ENOSYS: i32 = 38;
    const EEXIST: i32 = 17;
    const ENOENT: i32 = 2;

    fn c(path: &Path) -> std::io::Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    }
    let (from, to) = match (c(temp), c(target)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(ReplaceError::Unsupported),
    };
    let call = |flags: c_uint| unsafe {
        renameat2(AT_FDCWD, from.as_ptr(), AT_FDCWD, to.as_ptr(), flags)
    };

    match mode {
        // 交换后：target = 新内容，temp = 旧内容（随后由 remove_temp 清掉旧副本）
        CommitMode::ReplaceExisting => {
            if call(RENAME_EXCHANGE) == 0 {
                return Ok(());
            }
            match std::io::Error::last_os_error().raw_os_error().unwrap_or(0) {
                ENOENT => Err(ReplaceError::NotFound), // 目标不存在：绝不创建
                EINVAL | ENOSYS => fallback_rename_existing(temp, target),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
        // 非原子回退：先确认目标存在，再 rename（窗口见设计 R1）
        CommitMode::CreateExclusive => {
            if call(RENAME_NOREPLACE) == 0 {
                return Ok(());
            }
            match std::io::Error::last_os_error().raw_os_error().unwrap_or(0) {
                EEXIST => Err(ReplaceError::AlreadyExists),
                EINVAL | ENOSYS => create_exclusive_fallback(temp, target),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
        CommitMode::CreateOrReplace => std::fs::rename(temp, target)
            .map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => ReplaceError::NotFound,
                _ => ReplaceError::UnknownTargetState,
            }),
    }
}

#[cfg(target_os = "macos")]
pub fn platform_commit(mode: CommitMode, temp: &Path, target: &Path) -> Result<(), ReplaceError> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_uint};
    use std::os::unix::ffi::OsStrExt;

    extern "C" {
        fn renamex_np(from: *const c_char, to: *const c_char, flags: c_uint) -> c_int;
    }
    // renamex_np 的标志：RENAME_SWAP = 0x2，RENAME_EXCL = 0x4
    const RENAME_SWAP: c_uint = 0x2;
    const RENAME_EXCL: c_uint = 0x4;
    const EEXIST: i32 = 17;
    const ENOENT: i32 = 2;
    const ENOTSUP: i32 = 45;

    fn c(path: &Path) -> std::io::Result<CString> {
        CString::new(path.as_os_str().as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    }
    let (from, to) = match (c(temp), c(target)) {
        (Ok(a), Ok(b)) => (a, b),
        _ => return Err(ReplaceError::Unsupported),
    };

    match mode {
        CommitMode::ReplaceExisting => {
            if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_SWAP) } == 0 {
                return Ok(());
            }
            match std::io::Error::last_os_error().raw_os_error().unwrap_or(0) {
                ENOENT => Err(ReplaceError::NotFound),
                ENOTSUP => fallback_rename_existing(temp, target),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
        CommitMode::CreateExclusive => {
            if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), RENAME_EXCL) } == 0 {
                return Ok(());
            }
            match std::io::Error::last_os_error().raw_os_error().unwrap_or(0) {
                EEXIST => Err(ReplaceError::AlreadyExists),
                ENOTSUP => create_exclusive_fallback(temp, target),
                _ => Err(ReplaceError::UnknownTargetState),
            }
        }
        CommitMode::CreateOrReplace => std::fs::rename(temp, target).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ReplaceError::NotFound,
            _ => ReplaceError::UnknownTargetState,
        }),
    }
}

/// 其余平台（以及原语不可用时的回退）：`rename` 在 POSIX 上是替换语义，
/// 但目标缺失时会**创建**它，所以必须先确认目标存在（残留窗口见设计 R1/R2）。
#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
pub fn platform_commit(mode: CommitMode, temp: &Path, target: &Path) -> Result<(), ReplaceError> {
    match mode {
        CommitMode::ReplaceExisting => fallback_rename_existing(temp, target),
        CommitMode::CreateExclusive => create_exclusive_fallback(temp, target),
        CommitMode::CreateOrReplace => std::fs::rename(temp, target).map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ReplaceError::NotFound,
            _ => ReplaceError::UnknownTargetState,
        }),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos", not(any(windows, target_os = "linux", target_os = "macos"))))]
fn fallback_rename_existing(temp: &Path, target: &Path) -> Result<(), ReplaceError> {
    match std::fs::metadata(target) {
        Ok(meta) if meta.is_file() => std::fs::rename(temp, target)
            .map_err(|_| ReplaceError::UnknownTargetState),
        Ok(_) => Err(ReplaceError::AlreadyExists),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Err(ReplaceError::NotFound),
        Err(_) => Err(ReplaceError::UnknownTargetState),
    }
}

/// 无 NOREPLACE 时的排他创建：`hard_link` 在目标已存在时返回 EEXIST，
/// 成功后再删 temp（同目录，不会跨卷）。
#[cfg(any(target_os = "linux", target_os = "macos", not(any(windows, target_os = "linux", target_os = "macos"))))]
fn create_exclusive_fallback(temp: &Path, target: &Path) -> Result<(), ReplaceError> {
    match std::fs::hard_link(temp, target) {
        Ok(()) => {
            let _ = std::fs::remove_file(temp);
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err(ReplaceError::AlreadyExists),
        Err(_) => Err(ReplaceError::UnknownTargetState),
    }
}

// ── 登记表（recovery/temp-kept.json） ───────────────────────────────────────

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 全局单文件的半失败登记表（多窗口共用，`Mutex` 串行化 read-modify-write）。
pub struct TempKeptRegistry {
    file: PathBuf,
    entries: Mutex<Vec<TempKeptEntry>>,
}

impl TempKeptRegistry {
    /// 读一次文件；解析失败按空表处理（登记表损坏不应阻塞保存）。
    pub fn load(file: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&file)
            .ok()
            .and_then(|raw| serde_json::from_str::<TempKeptFile>(&raw).ok())
            .map(|f| f.entries)
            .unwrap_or_default();
        TempKeptRegistry { file, entries: Mutex::new(entries) }
    }

    /// 启动清理：把 temp 已不存在的条目一次删掉并**只写一次盘**。
    ///
    /// 逐条注销会让每条 stale 都做一遍「序列化 + rename + sync_all + 父目录 fsync」，
    /// 启动路径上 N 条 = N 次同步 IO；这里整表 retain 后只落盘一次。
    pub fn prune_missing(&self) -> Result<usize, CmdError> {
        let mut guard = self.entries.lock().expect("registry poisoned");
        let before = guard.len();
        guard.retain(|e| Path::new(&e.temp_path).exists());
        let removed = before - guard.len();
        if removed > 0 {
            self.persist(&guard)?;
        }
        Ok(removed)
    }

    fn persist(&self, entries: &[TempKeptEntry]) -> Result<(), CmdError> {
        let payload = TempKeptFile { version: 1, entries: entries.to_vec() };
        let json = serde_json::to_string_pretty(&payload)
            .map_err(|e| CmdError::new(ErrorCode::Io, format!("登记表序列化失败: {e}")))?;
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| CmdError::new(ErrorCode::Io, format!("创建登记表目录失败: {e}")))?;
        }
        let temp = self.file.with_extension("json.tmp");
        let write = || -> std::io::Result<()> {
            use std::io::Write;
            let mut file = File::create(&temp)?;
            file.write_all(json.as_bytes())?;
            file.sync_all()?;
            Ok(())
        };
        if let Err(e) = write() {
            let _ = std::fs::remove_file(&temp);
            return Err(CmdError::new(ErrorCode::Io, format!("写登记表失败: {e}")));
        }
        std::fs::rename(&temp, &self.file)
            .map_err(|e| CmdError::new(ErrorCode::Io, format!("替换登记表失败: {e}")))?;
        // 掉电丢登记会让 temp 变成未登记孤儿，所以这里必须落盘
        if let Some(parent) = self.file.parent() {
            let _ = File::open(parent).and_then(|f| f.sync_all());
        }
        Ok(())
    }
}

impl TempKeptStore for TempKeptRegistry {
    fn register(&self, temp: &Path, target: &Path) -> Result<(), CmdError> {
        let mut guard = self.entries.lock().expect("registry poisoned");
        let key = temp.display().to_string();
        if !guard.iter().any(|e| e.temp_path == key) {
            guard.push(TempKeptEntry {
                temp_path: key,
                target_path: target.display().to_string(),
                created_at: now_ms(),
            });
        }
        self.persist(&guard)
    }

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

#[cfg(test)]
mod engine_tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::sync::Arc;

    struct MockFs {
        target: RefCell<Option<FileStat>>,
        temp_present: Cell<bool>,
        parent_exists: bool,
        stat_errors: Cell<u32>,
        stat_errors_for_temp: Cell<u32>,
        written: RefCell<Vec<String>>,
        removed: RefCell<Vec<PathBuf>>,
        disk_text: RefCell<String>,
        sync_parent_calls: Cell<u32>,
        sync_temp_calls: Cell<u32>,
    }

    impl MockFs {
        fn new(target: Option<FileStat>) -> Self {
            MockFs {
                target: RefCell::new(target),
                temp_present: Cell::new(true),
                parent_exists: true,
                stat_errors: Cell::new(0),
                stat_errors_for_temp: Cell::new(0),
                written: RefCell::new(vec![]),
                removed: RefCell::new(vec![]),
                disk_text: RefCell::new(String::new()),
                sync_parent_calls: Cell::new(0),
                sync_temp_calls: Cell::new(0),
            }
        }
        fn removed_count(&self) -> usize {
            self.removed.borrow().len()
        }
    }

    impl Fs for MockFs {
        fn parent_exists(&self, _p: &Path) -> std::io::Result<bool> {
            Ok(self.parent_exists)
        }
        fn create_parent_dirs(&self, _p: &Path) -> std::io::Result<()> {
            Ok(())
        }
        fn stat(&self, p: &Path) -> std::io::Result<Option<FileStat>> {
            if p.extension().map(|e| e == "tmp").unwrap_or(false) {
                let n = self.stat_errors_for_temp.get();
                if n > 0 {
                    self.stat_errors_for_temp.set(n - 1);
                    return Err(std::io::Error::other("temp stat hiccup"));
                }
                return Ok(if self.temp_present.get() {
                    Some(FileStat { mtime_us: 111, size: 5 })
                } else {
                    None
                });
            }
            let n = self.stat_errors.get();
            if n > 0 {
                self.stat_errors.set(n - 1);
                return Err(std::io::Error::other("stat hiccup"));
            }
            Ok(*self.target.borrow())
        }
        fn write_temp(&self, target: &Path, content: &str) -> std::io::Result<(PathBuf, FileStat)> {
            self.written.borrow_mut().push(content.to_string());
            self.temp_present.set(true);
            Ok((target.with_extension("tmp"), FileStat { mtime_us: 111, size: content.len() as u64 }))
        }
        fn sync_temp(&self, _t: &Path) -> std::io::Result<()> {
            self.sync_temp_calls.set(self.sync_temp_calls.get() + 1);
            Ok(())
        }
        fn sync_parent(&self, _t: &Path) -> std::io::Result<()> {
            self.sync_parent_calls.set(self.sync_parent_calls.get() + 1);
            Ok(())
        }
        fn read_text(&self, _p: &Path) -> std::io::Result<String> {
            Ok(self.disk_text.borrow().clone())
        }
        fn remove_temp(&self, t: &Path) {
            self.removed.borrow_mut().push(t.to_path_buf());
            self.temp_present.set(false);
        }
        fn sleep_ms(&self, _ms: u64) {}
    }

    fn st(m: u64, s: u64) -> FileStat {
        FileStat { mtime_us: m, size: s }
    }

    struct Ctx {
        fs: MockFs,
        store: MutexTempKeptStore,
    }

    fn ctx(target: Option<FileStat>) -> Ctx {
        Ctx { fs: MockFs::new(target), store: MutexTempKeptStore::new(false) }
    }

    fn run<C>(c: &Ctx, mode: CommitMode, commit: C) -> Result<WriteReceipt, AtomicError>
    where
        C: FnMut(CommitMode, &Path, &Path) -> Result<(), ReplaceError>,
    {
        atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, mode,
                     ReceiptPolicy::MtimeAndSize, Durability::Sync, |_p| Ok(()), commit, &c.store)
    }

    // ── 基础清理语义 ──

    #[test]
    fn t_precheck_conflict_removes_temp_once() {
        let c = ctx(Some(st(1, 5)));
        let mut commits = 0;
        let r = atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::MtimeAndSize, Durability::Sync,
                             |_p| Err(AtomicError::Outcome(SaveOutcome::Conflict {
                                 disk: st(2, 5), temp_path: None, register_failed: false,
                             })),
                             |_m: CommitMode, _t: &Path, _g: &Path| { commits += 1; Ok(()) }, &c.store);
        assert!(matches!(r, Err(AtomicError::Outcome(SaveOutcome::Conflict { .. }))));
        assert_eq!(commits, 0);
        assert_eq!(c.fs.removed_count(), 1);
    }

    #[test]
    fn t_notfound_removes_temp() {
        let c = ctx(None);
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::NotFound));
        assert!(matches!(r, Err(AtomicError::Outcome(SaveOutcome::NotFound))));
        assert_eq!(c.fs.removed_count(), 1);
        assert!(c.store.entries().is_empty());
    }

    #[test]
    fn t_already_exists_removes_temp() {
        let c = ctx(Some(st(7, 3)));
        let r = run(&c, CommitMode::CreateExclusive, |_m, _t, _g| Err(ReplaceError::AlreadyExists));
        match r {
            Err(AtomicError::Outcome(SaveOutcome::Conflict { disk, temp_path, register_failed })) => {
                assert_eq!(disk, st(7, 3));
                assert!(temp_path.is_none());
                assert!(!register_failed);
            }
            _ => panic!("应为 Conflict"),
        }
        assert_eq!(c.fs.removed_count(), 1);
    }

    // ── 1176（一律不移回）/ 1177 ──

    /// 1176 + 目标不存在 → TempKept（带 temp/target），temp 保留并登记
    #[test]
    fn t1176_target_absent_is_tempkept() {
        let c = ctx(None);
        let err = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::ReplacementMoveFailed)).unwrap_err();
        match err {
            AtomicError::Cmd(e) => {
                assert_eq!(e.code, ErrorCode::TempKept);
                assert_eq!(e.path.as_deref(), Some("/d/a.tmp"));
                assert_eq!(e.target.as_deref(), Some("/d/a.md"));
            }
            _ => panic!("应为 TempKept"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// 1176 + 目标被外部重建 → Conflict{disk, temp_path}，**绝不把 temp 搬回旧路径**
    #[test]
    fn t1176_target_present_conflicts_without_revive() {
        let c = ctx(Some(st(42, 9)));
        let err = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::ReplacementMoveFailed)).unwrap_err();
        match err {
            AtomicError::Outcome(SaveOutcome::Conflict { disk, temp_path, register_failed }) => {
                assert_eq!(disk, st(42, 9));
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"));
                assert!(!register_failed);
            }
            _ => panic!("应为 Conflict"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
        // 关键：#363 —— 目标路径的内容未被我们改写
        assert_eq!(*c.fs.target.borrow(), Some(st(42, 9)));
    }

    /// 1176 + stat(temp) 失败 → 视为可能仍在，保留 + 登记，绝不返回 Written
    #[test]
    fn t1176_temp_unknown_never_returns_written() {
        let c = ctx(Some(st(42, 9)));
        c.fs.stat_errors_for_temp.set(100);
        let err = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::ReplacementMoveFailed)).unwrap_err();
        match err {
            AtomicError::Outcome(SaveOutcome::Conflict { temp_path, .. }) => {
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"))
            }
            AtomicError::Cmd(e) => assert_eq!(e.code, ErrorCode::TempKept),
            _ => panic!("stat(temp)=Err 时绝不能返回 Written"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// 1176 + temp 已不在、目标在 → 无法确认目标是否为我们所写 → Conflict，不谎报成功
    #[test]
    fn t1176_temp_gone_target_present_is_conflict() {
        let c = ctx(Some(st(999, 5)));
        let err = run(&c, CommitMode::ReplaceExisting, |_m: CommitMode, _t: &Path, _g: &Path| {
            c.fs.temp_present.set(false);      // commit 可能已移走 temp 又报错
            Err(ReplaceError::ReplacementMoveFailed)
        }).unwrap_err();
        match err {
            AtomicError::Outcome(SaveOutcome::Conflict { disk, temp_path, .. }) => {
                assert_eq!(disk, st(999, 5));
                assert!(temp_path.is_none(), "temp 已不在，不能谎称副本还在");
            }
            _ => panic!("应为 Conflict"),
        }
    }

    /// 1176 + 两边都不在 → Io，且不得声称"内容在 temp"
    #[test]
    fn t1176_both_gone_is_io() {
        let c = ctx(None);
        let err = run(&c, CommitMode::ReplaceExisting, |_m: CommitMode, _t: &Path, _g: &Path| {
            c.fs.temp_present.set(false);
            Err(ReplaceError::ReplacementMoveFailed)
        }).unwrap_err();
        match err {
            AtomicError::Cmd(e) => assert_eq!(e.code, ErrorCode::Io),
            _ => panic!("两边都不存在时应报 Io"),
        }
        assert_eq!(c.store.entries().len(), 0);
    }

    /// P2-5：旧写盘入口在 1176 下也必须给结构化错误（带 temp/target）
    #[test]
    fn t_write_text_file_sync_surfaces_temp() {
        let c = ctx(None);
        let err = write_text_file_sync(&c.fs, Path::new("/d/out.html"), "<h1/>",
                                       |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::ReplacementMoveFailed),
                                       &c.store).unwrap_err();
        assert_eq!(err.code, ErrorCode::TempKept);
        assert_eq!(err.path.as_deref(), Some("/d/out.tmp"));
        assert_eq!(err.target.as_deref(), Some("/d/out.html"));
        assert_eq!(c.store.entries().len(), 1, "旧入口也不能留下未登记 temp");
    }

    #[test]
    fn t1177_match_is_written_and_syncs_parent() {
        let c = ctx(Some(st(111, 5)));
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::PartialState)).unwrap();
        assert!(!r.foreign_write);
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.fs.sync_parent_calls.get(), 1);
    }

    #[test]
    fn t1177_mismatch_keeps_temp() {
        let c = ctx(Some(st(999, 5)));
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::PartialState));
        match r {
            Err(AtomicError::Outcome(SaveOutcome::Conflict { disk, temp_path, register_failed })) => {
                assert_eq!(disk, st(999, 5));
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"));
                assert!(!register_failed);
            }
            _ => panic!("应为 Conflict"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// P1-F：1177 登记失败也必须带 temp_path 且 register_failed=true
    #[test]
    fn t1177_mismatch_register_failure_still_exposes_temp() {
        let fs = MockFs::new(Some(st(999, 5)));
        let store = MutexTempKeptStore::new(true);
        let r = atomic_write(&fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::MtimeAndSize, Durability::Sync, |_p| Ok(()),
                             |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::PartialState), &store);
        match r {
            Err(AtomicError::Outcome(SaveOutcome::Conflict { temp_path, register_failed, .. })) => {
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"), "登记失败也不能丢 temp 路径");
                assert!(register_failed);
            }
            _ => panic!("应为 Conflict"),
        }
        assert_eq!(fs.removed_count(), 0);
    }

    /// 1177 且目标不存在 → 与 1176 同路：保留 temp + TempKept，**不在旧路径重建**
    #[test]
    fn t1177_target_none_keeps_temp_without_revive() {
        let c = ctx(None);
        let err = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::PartialState)).unwrap_err();
        match err {
            AtomicError::Cmd(e) => assert_eq!(e.code, ErrorCode::TempKept),
            _ => panic!("目标不存在时应为 TempKept"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
        assert!(*c.fs.target.borrow() == None, "不得在旧路径重建文件");
    }

    // ── 耗尽与未知 ──

    #[test]
    fn t1175_exhausted_removes_temp() {
        let c = ctx(Some(st(1, 5)));
        let mut attempts = 0;
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| {
            attempts += 1;
            Err(ReplaceError::Other)
        });
        match r {
            Err(AtomicError::Cmd(e)) => assert_eq!(e.code, ErrorCode::Io),
            _ => panic!("应为 Io"),
        }
        assert_eq!(attempts, MAX_ATTEMPTS);
        assert_eq!(c.fs.removed_count(), 1);
    }

    /// Unknown 耗尽 + 目标不存在 → TempKept（内容只在 temp）
    #[test]
    fn t_unknown_exhausted_keeps_temp_and_registers() {
        let c = ctx(None);
        let mut attempts = 0;
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| {
            attempts += 1;
            Err(ReplaceError::UnknownTargetState)
        });
        match r {
            Err(AtomicError::Cmd(e)) => {
                assert_eq!(e.code, ErrorCode::TempKept);
                assert_eq!(e.path.as_deref(), Some("/d/a.tmp"));
                assert_eq!(e.target.as_deref(), Some("/d/a.md"));
            }
            _ => panic!("应为 TempKept"),
        }
        assert_eq!(attempts, MAX_ATTEMPTS);
        assert_eq!(c.fs.removed_count(), 0, "状态未知绝不删 temp");
        assert_eq!(c.store.entries().len(), 1);
    }

    /// Unknown 耗尽 + 目标存在 → 带 tempPath 的 Conflict（让用户选覆盖/另存/采用 temp）
    #[test]
    fn t_unknown_exhausted_with_target_is_conflict_with_temp() {
        let c = ctx(Some(st(1, 5)));
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::UnknownTargetState));
        match r {
            Err(AtomicError::Outcome(SaveOutcome::Conflict { disk, temp_path, register_failed })) => {
                assert_eq!(disk, st(1, 5));
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"));
                assert!(!register_failed);
            }
            _ => panic!("应为带 tempPath 的 Conflict"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// P1-E：Unknown 之后 pre-check 发现冲突 → 仍不能删 temp
    #[test]
    fn t_unknown_then_precheck_conflict_keeps_temp() {
        let c = ctx(Some(st(1, 5)));
        let mut n = 0;
        let mut pre = |_p: &Path| -> Result<(), AtomicError> {
            n += 1;
            if n == 1 {
                Ok(())
            } else {
                Err(AtomicError::Outcome(SaveOutcome::Conflict {
                    disk: st(8, 5), temp_path: None, register_failed: false,
                }))
            }
        };
        let r = atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::MtimeAndSize, Durability::Sync, &mut pre,
                             |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::UnknownTargetState), &c.store);
        match r {
            Err(AtomicError::Outcome(SaveOutcome::Conflict { temp_path, register_failed, .. })) => {
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"));
                assert!(!register_failed);
            }
            _ => panic!("应为带 tempPath 的 Conflict"),
        }
        assert_eq!(c.fs.removed_count(), 0, "Unknown 之后的早退不得删 temp");
        assert_eq!(c.store.entries().len(), 1);
    }

    /// P1-E：Unknown 之后 commit 返回 NotFound → 也不能删
    #[test]
    fn t_unknown_then_notfound_keeps_temp() {
        let c = ctx(None);
        let mut n = 0;
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| {
            n += 1;
            if n == 1 { Err(ReplaceError::UnknownTargetState) } else { Err(ReplaceError::NotFound) }
        });
        match r {
            Err(AtomicError::Cmd(e)) => assert_eq!(e.code, ErrorCode::TempKept),
            _ => panic!("应为 TempKept"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// P1-E：Unknown 之后 AlreadyExists+Some → 带 tempPath 的 Conflict
    #[test]
    fn t_unknown_then_already_exists_keeps_temp() {
        let c = ctx(Some(st(3, 5)));
        let mut n = 0;
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| {
            n += 1;
            if n == 1 { Err(ReplaceError::UnknownTargetState) } else { Err(ReplaceError::AlreadyExists) }
        });
        match r {
            Err(AtomicError::Outcome(SaveOutcome::Conflict { temp_path, .. })) => {
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"));
            }
            _ => panic!("应为带 tempPath 的 Conflict"),
        }
        assert_eq!(c.fs.removed_count(), 0);
    }

    /// P1-E：AlreadyExists + stat 一直失败 → 视为唯一副本，耗尽后保留 + 登记
    #[test]
    fn t_already_exists_stat_err_keeps_temp() {
        let c = ctx(Some(st(1, 5)));
        *c.fs.target.borrow_mut() = None; // 目标不存在
        c.fs.stat_errors.set(100);        // 并且 stat 一直失败
        let mut attempts = 0;
        let r = run(&c, CommitMode::CreateExclusive, |_m, _t, _g| {
            attempts += 1;
            Err(ReplaceError::AlreadyExists)
        });
        match r {
            Err(AtomicError::Cmd(e)) => assert_eq!(e.code, ErrorCode::TempKept),
            _ => panic!("应为 TempKept（拿不到目标状态就不许删）"),
        }
        assert_eq!(attempts, MAX_ATTEMPTS);
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    // ── 回执 / 父目录 / 登记 ──

    #[test]
    fn t_register_failure_surfaces_with_target() {
        let fs = MockFs::new(None);
        let store = MutexTempKeptStore::new(true);
        let commit = |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::ReplacementMoveFailed);
        let err = atomic_write(&fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                               ReceiptPolicy::MtimeAndSize, Durability::Sync, |_p| Ok(()), commit, &store).unwrap_err();
        match err {
            AtomicError::Cmd(e) => {
                assert_eq!(e.code, ErrorCode::TempRegisterFailed);
                assert_eq!(e.path.as_deref(), Some("/d/a.tmp"));
                assert_eq!(e.target.as_deref(), Some("/d/a.md"));
            }
            _ => panic!("应为 TempRegisterFailed"),
        }
        assert_eq!(fs.removed_count(), 0);
    }

    #[test]
    fn t_parent_missing_writes_nothing() {
        let mut c = ctx(Some(st(1, 5)));
        c.fs.parent_exists = false;
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Ok(()));
        assert!(matches!(r, Err(AtomicError::Outcome(SaveOutcome::ParentMissing { .. }))));
        assert!(c.fs.written.borrow().is_empty());
        assert_eq!(c.fs.removed_count(), 0);
    }

    #[test]
    fn t_receipt_stat_retry() {
        let c = ctx(Some(st(111, 5)));
        c.fs.stat_errors.set(1);
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Ok(())).unwrap();
        assert_eq!(r.stat, st(111, 5));
    }

    #[test]
    fn t_receipt_stat_fail_is_conservative() {
        let c = ctx(Some(st(111, 5)));
        c.fs.stat_errors.set(10);
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Ok(())).unwrap();
        assert!(r.foreign_write);
        assert_eq!(r.stat, st(111, 5));
    }

    #[test]
    fn t_readback_policy_no_false_positive() {
        let c = ctx(Some(st(1, 5)));
        *c.fs.disk_text.borrow_mut() = "hello".into();
        let r = atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::ReadBack, Durability::Sync, |_p| Ok(()),
                             |_m: CommitMode, _t: &Path, _g: &Path| Ok(()), &c.store).unwrap();
        assert!(!r.foreign_write);
    }

    #[test]
    fn t_write_document_maps_outcomes() {
        let c = ctx(None);
        let out = write_document_with(&c.fs, Path::new("/d/a.md"), "hi", Some(st(1, 5)), false, false,
                                      ReceiptPolicy::MtimeAndSize, |_p| Ok(()),
                                      |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::NotFound), &c.store);
        assert_eq!(out.unwrap(), SaveOutcome::NotFound);
    }

    /// settle()：目标 stat 持续失败 → 三态 Unknown，保留 + 登记（不能当"不存在"）
    #[test]
    fn t_settle_target_unknown_keeps_temp() {
        let c = ctx(Some(st(1, 5)));
        c.fs.stat_errors.set(100);
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::UnknownTargetState));
        match r {
            Err(AtomicError::Cmd(e)) => assert_eq!(e.code, ErrorCode::TempKept),
            _ => panic!("目标状态未知时应保留 temp"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// pre-check 粘性分支：目标 stat 失败也不得删 temp
    #[test]
    fn t_sticky_precheck_target_unknown_keeps_temp() {
        let c = ctx(Some(st(1, 5)));
        let mut n = 0;
        let mut pre = |_p: &Path| -> Result<(), AtomicError> {
            n += 1;
            if n == 1 {
                Ok(())
            } else {
                Err(AtomicError::Cmd(CmdError {
                    code: ErrorCode::Io,
                    message: "precheck io".into(),
                    path: None,
                    target: None,
                }))
            }
        };
        let r = atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::MtimeAndSize, Durability::Sync, &mut pre,
                             |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::UnknownTargetState), &c.store);
        match r {
            // 目标存在 → 带 tempPath 的 Conflict
            Err(AtomicError::Outcome(SaveOutcome::Conflict { temp_path, .. })) => {
                assert_eq!(temp_path.as_deref(), Some("/d/a.tmp"))
            }
            // 目标不存在/未知 → TempKept
            Err(AtomicError::Cmd(_)) => {}
            _ => panic!("粘性置位后不得返回成功"),
        }
        assert_eq!(c.fs.removed_count(), 0);
        assert_eq!(c.store.entries().len(), 1);
    }

    /// 旧入口：1176 且目标存在 → 内部是 Conflict，外部仍映射为结构化 TempKept（带 temp/target）
    #[test]
    fn t_write_text_file_1176_rebuilt_is_structured() {
        let c = ctx(Some(st(42, 9)));
        let commit = |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::ReplacementMoveFailed);
        let err = write_text_file_sync(&c.fs, Path::new("/d/out.html"), "<h1/>", commit, &c.store).unwrap_err();
        assert_eq!(err.code, ErrorCode::TempKept);
        assert_eq!(err.path.as_deref(), Some("/d/out.tmp"));
        assert_eq!(err.target.as_deref(), Some("/d/out.html"));
        assert_eq!(c.store.entries().len(), 1);
        assert_eq!(c.fs.removed_count(), 0);
    }

    /// Durability::Sync → sync_temp 1 次、sync_parent 1 次
    #[test]
    fn t_durability_sync_syncs_once() {
        let c = ctx(Some(st(1, 5)));
        let r = atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::MtimeAndSize, Durability::Sync, |_p| Ok(()),
                             |_m: CommitMode, _t: &Path, _g: &Path| Ok(()), &c.store).unwrap();
        assert_eq!(r.stat, st(1, 5));
        assert_eq!(c.fs.sync_temp_calls.get(), 1, "Sync 必须 sync 临时文件");
        assert_eq!(c.fs.sync_parent_calls.get(), 1, "Sync 必须 fsync 父目录");
    }

    /// Durability::None → 一次 fsync 都不做
    #[test]
    fn t_durability_none_skips_fsync() {
        let c = ctx(Some(st(1, 5)));
        let r = atomic_write(&c.fs, Path::new("/d/a.md"), "hello", false, CommitMode::ReplaceExisting,
                             ReceiptPolicy::MtimeAndSize, Durability::None, |_p| Ok(()),
                             |_m: CommitMode, _t: &Path, _g: &Path| Ok(()), &c.store).unwrap();
        assert_eq!(r.stat, st(1, 5));
        assert_eq!(c.fs.sync_temp_calls.get(), 0, "None 不得 sync 临时文件");
        assert_eq!(c.fs.sync_parent_calls.get(), 0, "None 不得 fsync 父目录");
    }

    /// Unsupported → 平台内部回退成功 → Written，且**不置位**粘性标志
    #[test]
    fn t_unsupported_then_ok_is_written() {
        let c = ctx(Some(st(1, 5)));
        let mut n = 0;
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| {
            n += 1;
            if n == 1 { Err(ReplaceError::Unsupported) } else { Ok(()) }
        }).unwrap();
        assert_eq!(r.stat, st(1, 5));
        // 提交成功后必须自己清 temp：POSIX 的 RENAME_EXCHANGE 把旧目标留在 temp 路径上，
        // 不删就会在文档目录里留下 `.<name>.tmp.*`（Windows 的原语已消耗 temp，删除是 no-op）
        assert_eq!(c.fs.removed_count(), 1);
        assert!(c.store.entries().is_empty(), "Unsupported 不应留下 temp 登记");
    }

    /// Unsupported 持续失败 → 普通 Io（不是 TempKept），temp 可清
    #[test]
    fn t_unsupported_exhausted_is_io() {
        let c = ctx(Some(st(1, 5)));
        let r = run(&c, CommitMode::ReplaceExisting, |_m, _t, _g| Err(ReplaceError::Unsupported));
        match r {
            Err(AtomicError::Cmd(e)) => assert_eq!(e.code, ErrorCode::Io),
            _ => panic!("Unsupported 耗尽应为 Io"),
        }
        assert_eq!(c.fs.removed_count(), 1);
        assert!(c.store.entries().is_empty());
    }

    /// recovery 写入（RegisterPolicy::Never）：1176 半失败 → 删 temp + Io，不登记
    #[test]
    fn t_recovery_never_registers_on_1176() {
        let fs = MockFs::new(None);
        let store = NoRegisterStore;
        let err = atomic_write(&fs, Path::new("/r/drafts/a.json"), "{}", false, CommitMode::CreateOrReplace,
                               ReceiptPolicy::MtimeAndSize, Durability::None, |_p| Ok(()),
                               |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::ReplacementMoveFailed),
                               &store).unwrap_err();
        match err {
            AtomicError::Cmd(e) => assert_eq!(e.code, ErrorCode::Io),
            _ => panic!("Never 策略下应为 Io"),
        }
        assert_eq!(fs.removed_count(), 1, "必须删掉临时文件");
        assert!(store.entries().is_empty(), "绝不能登记");
    }

    /// recovery 写入：1177 不匹配 → 同样删 temp + Io
    #[test]
    fn t_recovery_never_registers_on_1177_mismatch() {
        let fs = MockFs::new(Some(st(999, 5)));
        let store = NoRegisterStore;
        let err = atomic_write(&fs, Path::new("/r/drafts/a.json"), "{}", false, CommitMode::CreateOrReplace,
                               ReceiptPolicy::MtimeAndSize, Durability::None, |_p| Ok(()),
                               |_m: CommitMode, _t: &Path, _g: &Path| Err(ReplaceError::PartialState),
                               &store).unwrap_err();
        match err {
            AtomicError::Cmd(e) => assert_eq!(e.code, ErrorCode::Io),
            _ => panic!("Never 策略下应为 Io"),
        }
        assert_eq!(fs.removed_count(), 1);
        assert!(store.entries().is_empty());
    }

    /// 真并发：MutexTempKeptStore 必须保留两笔（不是"顺序调两次"）
    #[test]
    fn t_concurrent_registration_keeps_both() {
        let store = Arc::new(MutexTempKeptStore::new(false));
        let s1 = store.clone();
        let s2 = store.clone();
        let h1 = std::thread::spawn(move || s1.register(Path::new("/d/a.tmp"), Path::new("/d/a.md")).unwrap());
        let h2 = std::thread::spawn(move || s2.register(Path::new("/d/b.tmp"), Path::new("/d/b.md")).unwrap());
        h1.join().unwrap();
        h2.join().unwrap();
        assert_eq!(store.entries().len(), 2);
    }
}

