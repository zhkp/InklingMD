// 图片资源命令（Smart Paste 远程图片落盘，#220）
//
// - download_remote_image：下载网页富文本里的远程 <img src>。前端受 CSP（connect-src
//   回落到 'self'）与 CORS 约束无法直接 fetch 第三方图片，只能由后端下载。
// - find_asset_by_hash：落盘前在目标 assets/ 目录里按内容哈希查找已有文件，
//   命中则复用，避免重复粘贴同一张图产生多份副本。
//
// 安全约束：
// - 只接受 http/https；重定向最多 5 次且只在 http/https 之间跳转（reqwest 默认策略）
// - 不发送 Referer（与 #162 的 referrerpolicy="no-referrer" 一致，不向图床泄漏来源页）
// - 单图体积上限、总超时；流式读取，超限立即中止，不先把整个响应读进内存
// - 按魔数识别位图格式；SVG 一律拒绝（可含脚本，落盘后在其他查看器里打开有 XSS 风险），
//   HTML 错误页等非图片内容拒绝，避免写出损坏的「图片」

use base64::Engine;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Once;
use std::time::Duration;

/// 错误标记：前端按前缀映射为用户可读提示（与 src/lib/fs.ts 保持契约一致）
pub const REMOTE_IMAGE_BAD_URL: &str = "REMOTE_IMAGE_BAD_URL";
pub const REMOTE_IMAGE_FORBIDDEN: &str = "REMOTE_IMAGE_FORBIDDEN";
pub const REMOTE_IMAGE_HTTP_STATUS: &str = "REMOTE_IMAGE_HTTP_STATUS";
pub const REMOTE_IMAGE_TIMEOUT: &str = "REMOTE_IMAGE_TIMEOUT";
pub const REMOTE_IMAGE_TOO_LARGE: &str = "REMOTE_IMAGE_TOO_LARGE";
pub const REMOTE_IMAGE_NOT_IMAGE: &str = "REMOTE_IMAGE_NOT_IMAGE";
pub const REMOTE_IMAGE_SVG: &str = "REMOTE_IMAGE_SVG";
pub const REMOTE_IMAGE_NETWORK: &str = "REMOTE_IMAGE_NETWORK";

/// 单图体积上限（10MB）
pub const MAX_REMOTE_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// 单次下载总超时
const REMOTE_IMAGE_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone, Copy)]
pub struct DownloadLimits {
    pub max_bytes: u64,
    pub timeout: Duration,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        Self {
            max_bytes: MAX_REMOTE_IMAGE_BYTES,
            timeout: Duration::from_secs(REMOTE_IMAGE_TIMEOUT_SECS),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RemoteImage {
    /// Base64 编码的图片字节（与 write_binary_file 的传输格式一致）
    pub data: String,
    /// 按魔数识别出的 MIME（image/png 等），前端据此决定扩展名
    pub mime: String,
}

/// 按文件头魔数识别位图格式，返回 MIME；无法识别返回 None
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") && bytes.len() >= 26 {
        return Some("image/bmp");
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && (&bytes[8..12] == b"avif" || &bytes[8..12] == b"avis") {
        return Some("image/avif");
    }
    None
}

/// 内容是否为 SVG（去掉 BOM 与前导空白后以 `<svg` / `<?xml` 开头）
fn looks_like_svg(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
    trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"))
}

fn validate_url(url: &str) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|e| format!("{REMOTE_IMAGE_BAD_URL}: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        other => return Err(format!("{REMOTE_IMAGE_BAD_URL}: 不支持的协议 {other}")),
    }
    if parsed.host_str().map_or(true, str::is_empty) {
        return Err(format!("{REMOTE_IMAGE_BAD_URL}: 缺少主机名"));
    }
    Ok(parsed)
}

fn install_crypto_provider() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        // 已被其他组件安装过时返回 Err，忽略即可
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

fn map_reqwest_error(e: reqwest::Error) -> String {
    if e.is_timeout() {
        format!("{REMOTE_IMAGE_TIMEOUT}: {e}")
    } else {
        format!("{REMOTE_IMAGE_NETWORK}: {e}")
    }
}

/// 下载远程图片（可注入上限，便于测试）
pub async fn download_image(url: &str, limits: DownloadLimits) -> Result<RemoteImage, String> {
    let parsed = validate_url(url)?;
    install_crypto_provider();
    let client = reqwest::Client::builder()
        .timeout(limits.timeout)
        .connect_timeout(limits.timeout)
        .redirect(reqwest::redirect::Policy::limited(5))
        // 重定向时也不补 Referer
        .referer(false)
        .user_agent(concat!("InklingMD/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| format!("{REMOTE_IMAGE_NETWORK}: {e}"))?;

    let mut resp = client
        .get(parsed)
        .header(reqwest::header::ACCEPT, "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8")
        .send()
        .await
        .map_err(map_reqwest_error)?;

    let status = resp.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(format!("{REMOTE_IMAGE_FORBIDDEN}: HTTP 403"));
    }
    if !status.is_success() {
        return Err(format!("{REMOTE_IMAGE_HTTP_STATUS}: HTTP {}", status.as_u16()));
    }
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.contains("svg") {
        return Err(format!("{REMOTE_IMAGE_SVG}: {content_type}"));
    }
    if let Some(len) = resp.content_length() {
        if len > limits.max_bytes {
            return Err(format!("{REMOTE_IMAGE_TOO_LARGE}: {len} 字节"));
        }
    }

    let mut body: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(map_reqwest_error)? {
        if body.len() as u64 + chunk.len() as u64 > limits.max_bytes {
            return Err(format!("{REMOTE_IMAGE_TOO_LARGE}: 超过 {} 字节", limits.max_bytes));
        }
        body.extend_from_slice(&chunk);
    }

    if looks_like_svg(&body) {
        return Err(format!("{REMOTE_IMAGE_SVG}: 内容为 SVG"));
    }
    let mime = sniff_image_mime(&body)
        .ok_or_else(|| format!("{REMOTE_IMAGE_NOT_IMAGE}: 无法识别的图片格式（Content-Type: {content_type}）"))?;
    Ok(RemoteImage {
        data: base64::engine::general_purpose::STANDARD.encode(&body),
        mime: mime.to_string(),
    })
}

/// 下载远程图片（http/https，单图 ≤10MB，15 秒超时，不发送 Referer，拒绝 SVG 与非图片）
#[tauri::command]
pub async fn download_remote_image(url: String) -> Result<RemoteImage, String> {
    download_image(&url, DownloadLimits::default()).await
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

fn find_asset_by_hash_sync(dir_path: &str, size: u64, sha256: &str) -> Result<Option<String>, String> {
    let dir = Path::new(dir_path);
    if !dir.is_dir() {
        // 目录尚不存在（首次粘贴）：没有可复用的文件
        return Ok(None);
    }
    let wanted = sha256.trim().to_ascii_lowercase();
    if wanted.len() != 64 || !wanted.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!("非法的 SHA-256: {sha256}"));
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败 {}: {}", dir.display(), e))?;
    let mut candidates: Vec<(String, std::path::PathBuf)> = Vec::new();
    for entry in entries.flatten() {
        // symlink_metadata：不跟随符号链接，只比对目录内真实的普通文件
        let Ok(meta) = entry.path().symlink_metadata() else { continue };
        if !meta.is_file() || meta.len() != size {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        candidates.push((name, entry.path()));
    }
    // 结果确定化：多个相同内容的历史副本时稳定地返回字典序最小的那个
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, path) in candidates {
        if sha256_file(&path).map(|h| h == wanted).unwrap_or(false) {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// 在 assets 目录中查找与给定内容（大小 + SHA-256）完全相同的文件，返回文件名。
/// 先按大小过滤，只对同尺寸文件计算哈希，目录里图片再多也只读极少数文件。
#[tauri::command]
pub async fn find_asset_by_hash(dir_path: String, size: u64, sha256: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || find_asset_by_hash_sync(&dir_path, size, &sha256))
        .await
        .map_err(|e| format!("查重任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R'];

    /// 极简 HTTP 服务：按路径返回预设响应，记录请求头供断言
    fn serve(routes: Vec<(&'static str, Vec<u8>)>) -> (String, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    request.push_str(&line);
                }
                let path = request.split_whitespace().nth(1).unwrap_or("/").to_string();
                let _ = tx.send(request.clone());
                let body = routes
                    .iter()
                    .find(|(p, _)| *p == path)
                    .map(|(_, r)| r.clone())
                    .unwrap_or_else(|| b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec());
                if body.starts_with(b"SLEEP") {
                    thread::sleep(Duration::from_millis(1500));
                    continue;
                }
                let _ = stream.write_all(&body);
            }
        });
        (format!("http://{addr}"), rx)
    }

    fn ok_response(content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    fn limits(max_bytes: u64) -> DownloadLimits {
        DownloadLimits { max_bytes, timeout: Duration::from_millis(800) }
    }

    #[test]
    fn downloads_png_without_referer() {
        let (base, rx) = serve(vec![("/a.png", ok_response("image/png", PNG))]);
        let img = run(download_image(&format!("{base}/a.png"), limits(1024))).unwrap();
        assert_eq!(img.mime, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD.decode(img.data).unwrap();
        assert_eq!(decoded, PNG);
        let request = rx.recv().unwrap().to_ascii_lowercase();
        assert!(!request.contains("referer:"), "不得发送 Referer: {request}");
    }

    #[test]
    fn sniffs_format_even_when_content_type_lies() {
        let (base, _rx) = serve(vec![("/img", ok_response("application/octet-stream", PNG))]);
        let img = run(download_image(&format!("{base}/img"), limits(1024))).unwrap();
        assert_eq!(img.mime, "image/png");
    }

    #[test]
    fn reports_403_distinctly() {
        let (base, _rx) = serve(vec![(
            "/hotlink.png",
            b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
        )]);
        let err = run(download_image(&format!("{base}/hotlink.png"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_FORBIDDEN), "{err}");
    }

    #[test]
    fn reports_other_http_status() {
        let (base, _rx) = serve(vec![]);
        let err = run(download_image(&format!("{base}/missing.png"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_HTTP_STATUS) && err.contains("404"), "{err}");
    }

    #[test]
    fn rejects_declared_oversize_before_reading_body() {
        let (base, _rx) = serve(vec![("/big.png", ok_response("image/png", &[0u8; 2048]))]);
        let err = run(download_image(&format!("{base}/big.png"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_TOO_LARGE), "{err}");
    }

    #[test]
    fn rejects_undeclared_oversize_while_streaming() {
        let mut body = b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nConnection: close\r\n\r\n".to_vec();
        body.extend_from_slice(PNG);
        body.extend_from_slice(&[0u8; 4096]);
        let (base, _rx) = serve(vec![("/stream.png", body)]);
        let err = run(download_image(&format!("{base}/stream.png"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_TOO_LARGE), "{err}");
    }

    #[test]
    fn rejects_svg_by_content_type_and_by_content() {
        let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>";
        let (base, _rx) = serve(vec![
            ("/a.svg", ok_response("image/svg+xml", svg)),
            ("/disguised.png", ok_response("image/png", svg)),
        ]);
        let err = run(download_image(&format!("{base}/a.svg"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_SVG), "{err}");
        let err = run(download_image(&format!("{base}/disguised.png"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_SVG), "{err}");
    }

    #[test]
    fn rejects_non_image_bodies() {
        let (base, _rx) = serve(vec![("/login", ok_response("text/html", b"<html>login</html>"))]);
        let err = run(download_image(&format!("{base}/login"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_NOT_IMAGE), "{err}");
    }

    #[test]
    fn times_out_on_stalled_server() {
        let (base, _rx) = serve(vec![("/slow.png", b"SLEEP".to_vec())]);
        let err = run(download_image(&format!("{base}/slow.png"), limits(1024))).unwrap_err();
        assert!(err.starts_with(REMOTE_IMAGE_TIMEOUT) || err.starts_with(REMOTE_IMAGE_NETWORK), "{err}");
    }

    #[test]
    fn follows_redirect_to_image() {
        let (base, _rx) = serve(vec![
            ("/old.png", b"HTTP/1.1 302 Found\r\nLocation: /a.png\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()),
            ("/a.png", ok_response("image/png", PNG)),
        ]);
        let img = run(download_image(&format!("{base}/old.png"), limits(1024))).unwrap();
        assert_eq!(img.mime, "image/png");
    }

    #[test]
    fn rejects_non_http_schemes_without_network() {
        for url in ["file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://x/a.png", "not a url"] {
            let err = run(download_image(url, limits(1024))).unwrap_err();
            assert!(err.starts_with(REMOTE_IMAGE_BAD_URL), "{url}: {err}");
        }
    }

    /// 真实 HTTPS 下载（rustls + ring + 系统信任库）。需要外网，默认不跑：
    /// `cargo test --lib assets -- --ignored`
    #[test]
    #[ignore]
    fn downloads_over_https_with_system_trust_store() {
        let img = run(download_image(
            "https://www.rust-lang.org/logos/rust-logo-128x128.png",
            DownloadLimits::default(),
        ))
        .unwrap();
        assert_eq!(img.mime, "image/png");
    }

    #[test]
    fn sniff_recognizes_common_formats() {
        assert_eq!(sniff_image_mime(PNG), Some("image/png"));
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"<html>"), None);
        assert_eq!(sniff_image_mime(&[]), None);
    }

    struct TempDir(PathBuf);
    impl TempDir {
        fn new(label: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "inkling-assets-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn sha_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn finds_identical_file_by_size_and_hash() {
        let dir = TempDir::new("hit");
        fs::write(dir.0.join("1700000000000-abc.png"), b"same-bytes").unwrap();
        fs::write(dir.0.join("other.png"), b"diff-bytes").unwrap(); // 同尺寸不同内容
        fs::write(dir.0.join("longer.png"), b"same-bytes-but-longer").unwrap();
        let found = find_asset_by_hash_sync(dir.0.to_str().unwrap(), 10, &sha_hex(b"same-bytes")).unwrap();
        assert_eq!(found.as_deref(), Some("1700000000000-abc.png"));
    }

    #[test]
    fn misses_when_no_identical_content() {
        let dir = TempDir::new("miss");
        fs::write(dir.0.join("a.png"), b"aaaa").unwrap();
        let found = find_asset_by_hash_sync(dir.0.to_str().unwrap(), 4, &sha_hex(b"bbbb")).unwrap();
        assert_eq!(found, None);
    }

    #[test]
    fn missing_directory_is_not_an_error() {
        let dir = TempDir::new("missing");
        let absent = dir.0.join("assets");
        let found = find_asset_by_hash_sync(absent.to_str().unwrap(), 4, &sha_hex(b"bbbb")).unwrap();
        assert_eq!(found, None);
    }

    #[test]
    fn ignores_subdirectories_hidden_files_and_bad_hashes() {
        let dir = TempDir::new("ignore");
        fs::create_dir_all(dir.0.join("nested")).unwrap();
        fs::write(dir.0.join("nested").join("x.png"), b"data").unwrap();
        fs::write(dir.0.join(".hidden.png"), b"data").unwrap();
        let found = find_asset_by_hash_sync(dir.0.to_str().unwrap(), 4, &sha_hex(b"data")).unwrap();
        assert_eq!(found, None);
        assert!(find_asset_by_hash_sync(dir.0.to_str().unwrap(), 4, "not-a-hash").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_follow_symlinks() {
        let dir = TempDir::new("symlink");
        let outside = TempDir::new("symlink-target");
        fs::write(outside.0.join("secret.png"), b"data").unwrap();
        std::os::unix::fs::symlink(outside.0.join("secret.png"), dir.0.join("link.png")).unwrap();
        let found = find_asset_by_hash_sync(dir.0.to_str().unwrap(), 4, &sha_hex(b"data")).unwrap();
        assert_eq!(found, None);
    }
}
