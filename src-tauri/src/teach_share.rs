use crate::positions::{self, CapturedPose};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

const PREFERRED_PORT: u16 = 17420;
const DEV_PROXY: (&str, u16) = ("127.0.0.1", 1420);
const MAX_BODY: usize = 64 * 1024;

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeachShareInfo {
    pub url: String,
    pub port: u16,
    pub lan_ip: String,
    pub bridge_connected: bool,
}

pub struct TeachShareState {
    session: Mutex<Option<RunningShare>>,
}

impl Default for TeachShareState {
    fn default() -> Self {
        Self { session: Mutex::new(None) }
    }
}

struct RunningShare {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    info: TeachShareInfo,
    config: Arc<RuntimeConfig>,
}

enum Frontend {
    Proxy { host: String, port: u16 },
    Files { roots: Vec<PathBuf>, app: Option<AppHandle> },
}

struct FeedbackSnapshot {
    bridge_connected: bool,
    positions: Option<Vec<f64>>,
    gripper_position: Option<f64>,
    error: String,
    published_ms: u64,
}

struct PendingCapture {
    id: String,
    positions: Vec<f64>,
    gripper_position: Option<f64>,
    profile_key: String,
    created_ms: u64,
}

struct LiveClient {
    id: u64,
    stream: Arc<Mutex<TcpStream>>,
}

struct RuntimeConfig {
    token: String,
    profile_key: Mutex<String>,
    positions_path: PathBuf,
    frontend: Frontend,
    on_change: Arc<dyn Fn() + Send + Sync>,
    file_lock: Mutex<()>,
    feedback: Mutex<FeedbackSnapshot>,
    captures: Mutex<Vec<PendingCapture>>,
    listeners: Mutex<Vec<LiveClient>>,
    next_listener: Mutex<u64>,
    stop: Arc<AtomicBool>,
}

pub fn format_teach_share_url(lan_ip: &str, port: u16, token: &str) -> String {
    format!("http://{lan_ip}:{port}/teach?token={token}")
}

pub fn primary_lan_ipv4() -> Result<String, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|error| format!("无法检测局域网地址：{error}"))?;
    socket.connect("192.0.2.1:9").map_err(|error| format!("无法检测局域网地址：{error}"))?;
    match socket.local_addr().map_err(|error| format!("无法检测局域网地址：{error}"))?.ip() {
        IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_unspecified() && !ip.is_link_local() => Ok(ip.to_string()),
        other => Err(format!("没有可用的局域网 IPv4 地址（当前 {other}）")),
    }
}

fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|error| format!("无法生成分享令牌：{error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn bind_lan_listener() -> Result<TcpListener, String> {
    let mut last = "无法监听局域网端口".to_string();
    let mut ports = Vec::new();
    for offset in 0..21 {
        ports.push(PREFERRED_PORT.saturating_add(offset));
    }
    ports.push(0);
    for port in ports {
        match TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)) {
            Ok(listener) => return Ok(listener),
            Err(error) => last = format!("无法监听局域网端口：{error}"),
        }
    }
    Err(last)
}

fn dev_proxy_open() -> bool {
    TcpStream::connect_timeout(&format!("{}:{}", DEV_PROXY.0, DEV_PROXY.1).parse().unwrap(), Duration::from_millis(200)).is_ok()
}

fn dist_roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(resource) = app.path().resource_dir() {
        roots.push(resource.join("dist"));
        roots.push(resource);
    }
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("dist"));
        roots.push(cwd.join("../dist"));
    }
    roots.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist"));
    roots
}

#[tauri::command]
pub fn teach_share_status(state: State<TeachShareState>) -> Result<Option<TeachShareInfo>, String> {
    let session = state.session.lock().map_err(|_| "分享状态不可用")?;
    Ok(session.as_ref().map(|running| {
        let mut info = running.info.clone();
        info.bridge_connected = running.config.feedback.lock().map(|feedback| feedback.bridge_connected).unwrap_or(false);
        info
    }))
}

#[tauri::command]
pub fn teach_share_stop(state: State<TeachShareState>) -> Result<(), String> {
    let mut session = state.session.lock().map_err(|_| "分享状态不可用")?;
    stop_locked(&mut session);
    Ok(())
}

#[tauri::command]
pub fn teach_share_publish_feedback(
    state: State<TeachShareState>,
    bridge_connected: bool,
    profile_key: String,
    positions: Option<Vec<f64>>,
    gripper_position: Option<f64>,
    error: String,
) -> Result<(), String> {
    let session = state.session.lock().map_err(|_| "分享状态不可用")?;
    if let Some(running) = session.as_ref() {
        publish_feedback(&running.config, bridge_connected, profile_key, positions, gripper_position, error);
    }
    Ok(())
}

#[tauri::command]
pub fn teach_share_start(app: AppHandle, state: State<TeachShareState>, profile_key: String) -> Result<TeachShareInfo, String> {
    if profile_key.is_empty() || profile_key.len() > 512 || profile_key.chars().any(|ch| ch.is_control()) {
        return Err("连接键无效".into());
    }
    let lan_ip = primary_lan_ipv4()?;
    let token = random_token()?;
    let listener = bind_lan_listener()?;
    listener.set_nonblocking(true).map_err(|error| format!("无法监听局域网端口：{error}"))?;
    let port = listener.local_addr().map_err(|error| format!("无法读取分享端口：{error}"))?.port();
    let positions_path = positions::positions_file(&app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?);
    let info = TeachShareInfo {
        url: format_teach_share_url(&lan_ip, port, &token),
        port,
        lan_ip,
        bridge_connected: false,
    };
    let stop = Arc::new(AtomicBool::new(false));
    let emitter = app.clone();
    let frontend = if dev_proxy_open() {
        Frontend::Proxy { host: DEV_PROXY.0.into(), port: DEV_PROXY.1 }
    } else {
        Frontend::Files { roots: dist_roots(&app), app: Some(app) }
    };
    let config = Arc::new(RuntimeConfig {
        token,
        profile_key: Mutex::new(profile_key),
        positions_path,
        frontend,
        on_change: Arc::new(move || { let _ = emitter.emit("teach-poses-changed", ()); }),
        file_lock: Mutex::new(()),
        feedback: Mutex::new(disconnected_feedback()),
        captures: Mutex::new(Vec::new()),
        listeners: Mutex::new(Vec::new()),
        next_listener: Mutex::new(1),
        stop: stop.clone(),
    });
    let thread_config = config.clone();
    let thread = thread::Builder::new()
        .name("teach-share".into())
        .spawn(move || accept_loop(listener, thread_config))
        .map_err(|error| format!("无法启动分享服务：{error}"))?;
    let mut session = state.session.lock().map_err(|_| "分享状态不可用")?;
    stop_locked(&mut session);
    *session = Some(RunningShare { stop, thread: Some(thread), info: info.clone(), config });
    Ok(info)
}

fn stop_locked(session: &mut Option<RunningShare>) {
    if let Some(mut running) = session.take() {
        running.stop.store(true, Ordering::Relaxed);
        if let Ok(mut listeners) = running.config.listeners.lock() {
            for listener in listeners.drain(..) {
                if let Ok(stream) = listener.stream.lock() {
                    let _ = stream.shutdown(Shutdown::Both);
                }
            }
        }
        if let Some(thread) = running.thread.take() {
            let _ = thread.join();
        }
    }
}

fn accept_loop(listener: TcpListener, config: Arc<RuntimeConfig>) {
    while !config.stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
                let config = config.clone();
                let _ = thread::Builder::new().name("teach-share-conn".into()).spawn(move || {
                    if let Err(error) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handle_client(stream, &config))) {
                        let _ = error;
                    }
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(40)),
            Err(_) => thread::sleep(Duration::from_millis(40)),
        }
    }
}

fn handle_client(mut stream: TcpStream, config: &RuntimeConfig) {
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(error) => {
            let _ = stream.write_all(&http_response(400, "application/json; charset=utf-8", json!({ "error": error }).to_string().into_bytes()));
            let _ = stream.shutdown(Shutdown::Both);
            return;
        }
    };
    if is_live_socket(&request) {
        handle_websocket(stream, config, &request);
        return;
    }
    let _ = stream.set_read_timeout(Some(Duration::from_secs(8)));
    let response = dispatch(config, &request);
    let _ = stream.write_all(&response);
    let _ = stream.shutdown(Shutdown::Both);
}

struct Request {
    method: String,
    path: String,
    query: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    let header_bytes = read_until(stream, b"\r\n\r\n", 16 * 1024)?;
    let header_text = String::from_utf8_lossy(&header_bytes);
    let mut lines = header_text.split("\r\n");
    let request_line = lines.next().ok_or("请求不完整")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("/");
    let (path, query) = target.split_once('?').map(|(path, query)| (path.to_string(), query.to_string())).unwrap_or((target.to_string(), String::new()));
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let length = headers.get("content-length").and_then(|value| value.parse::<usize>().ok()).unwrap_or(0);
    if length > MAX_BODY {
        return Err("请求体过大".into());
    }
    let mut body = vec![0; length];
    if length > 0 {
        stream.read_exact(&mut body).map_err(|_| "请求体不完整".to_string())?;
    }
    Ok(Request { method, path, query, headers, body })
}

fn read_until(stream: &mut TcpStream, marker: &[u8], cap: usize) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while buf.len() < cap {
        let read = stream.read(&mut byte).map_err(|error| format!("读取请求失败：{error}"))?;
        if read == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(marker) {
            return Ok(buf);
        }
    }
    if buf.ends_with(marker) {
        return Ok(buf);
    }
    Err("请求头不完整".into())
}

fn dispatch(config: &RuntimeConfig, request: &Request) -> Vec<u8> {
    let asset_path = match sanitize_path(&request.path) {
        Ok(path) => path,
        Err(error) => return http_response(400, "application/json; charset=utf-8", json!({ "error": error }).to_string().into_bytes()),
    };
    if asset_path == "api/teach/poses" || asset_path.starts_with("api/teach/poses/") || asset_path == "api/teach/feedback" || asset_path == "api/teach/capture" {
        return dispatch_api(config, request, &asset_path);
    }
    if request.method != "GET" && request.method != "HEAD" {
        return http_response(405, "application/json; charset=utf-8", json!({ "error": "不支持的方法" }).to_string().into_bytes());
    }
    let file_path = if asset_path == "teach" || asset_path == "index.html" { "index.html".to_string() } else { asset_path };
    match load_frontend(&config.frontend, &file_path, &request.query) {
        Ok((status, mime, mut body)) => {
            if mime.contains("html") {
                if let Ok(text) = String::from_utf8(body.clone()) {
                    body = without_csp_meta(&text).into_bytes();
                }
            }
            if request.method == "HEAD" {
                body.clear();
            }
            http_response(status, &mime, body)
        }
        Err(error) => http_response(404, "application/json; charset=utf-8", json!({ "error": error }).to_string().into_bytes()),
    }
}

fn dispatch_api(config: &RuntimeConfig, request: &Request, asset_path: &str) -> Vec<u8> {
    let given = request_token(request);
    if !token_matches(&config.token, &given) {
        return http_response(401, "application/json; charset=utf-8", json!({ "error": "分享令牌无效" }).to_string().into_bytes());
    }
    let result = (|| -> Result<(u16, Value), String> {
        match (request.method.as_str(), asset_path) {
            ("GET", "api/teach/feedback") => Ok((200, feedback_json(config))),
            ("POST", "api/teach/capture") => Ok((200, freeze_capture(config)?)),
            ("GET", "api/teach/poses") => {
                let profile_key = current_profile_key(config)?;
                let _guard = config.file_lock.lock().map_err(|_| "姿态库正忙")?;
                Ok((200, json!({ "positions": positions::list_captured_poses(&config.positions_path, &profile_key)? })))
            }
            ("POST", "api/teach/poses") => {
                let body: SaveBody = serde_json::from_slice(&request.body).map_err(|_| "点位内容无效")?;
                let capture = take_capture(config, &body.capture_id)?;
                let now = now_ms();
                let saved = {
                    let _guard = config.file_lock.lock().map_err(|_| "姿态库正忙")?;
                    positions::append_captured_pose(&config.positions_path, &capture.profile_key, &CapturedPose {
                        name: body.name.clone(),
                        positions: capture.positions.clone(),
                        note: body.note.clone(),
                        // A present field only means "include the frozen opening". The phone cannot supply the stroke.
                        gripper_position: body.gripper_position.and(capture.gripper_position),
                    }, now, &random_token().unwrap_or_else(|_| format!("pose-{now}")))
                };
                match saved {
                    Ok(saved) => {
                        (config.on_change)();
                        Ok((201, json!({ "position": saved })))
                    }
                    Err(error) => {
                        if let Ok(mut captures) = config.captures.lock() {
                            captures.push(capture);
                        }
                        Err(error)
                    }
                }
            }
            ("DELETE", path) if path.starts_with("api/teach/poses/") => {
                let id = path.trim_start_matches("api/teach/poses/");
                if id.is_empty() || !id.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_') {
                    return Err("点位不存在".into());
                }
                let profile_key = current_profile_key(config)?;
                let _guard = config.file_lock.lock().map_err(|_| "姿态库正忙")?;
                positions::delete_captured_pose(&config.positions_path, &profile_key, id)?;
                drop(_guard);
                (config.on_change)();
                Ok((200, json!({ "ok": true })))
            }
            ("GET" | "POST" | "DELETE", _) => Err("点位不存在".into()),
            _ => Err("不支持的方法".into()),
        }
    })();
    match result {
        Ok((status, body)) => http_response(status, "application/json; charset=utf-8", body.to_string().into_bytes()),
        Err(error) => {
            let status = if error.contains("尚未连接") { 409 } else if error.contains("不存在") { 404 } else if error.contains("不支持") { 405 } else { 400 };
            http_response(status, "application/json; charset=utf-8", json!({ "error": error }).to_string().into_bytes())
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveBody {
    name: String,
    capture_id: String,
    #[serde(default)]
    note: String,
    gripper_position: Option<f64>,
}

fn disconnected_feedback() -> FeedbackSnapshot {
    FeedbackSnapshot {
        bridge_connected: false,
        positions: None,
        gripper_position: None,
        error: "桌面端尚未连接 Jetson Bridge".into(),
        published_ms: 0,
    }
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or(0)
}

fn current_profile_key(config: &RuntimeConfig) -> Result<String, String> {
    config.profile_key.lock().map(|key| key.clone()).map_err(|_| "姿态库正忙".into())
}

fn publish_feedback(config: &RuntimeConfig, bridge_connected: bool, profile_key: String, positions: Option<Vec<f64>>, gripper_position: Option<f64>, error: String) {
    if !profile_key.is_empty() {
        if let Ok(mut key) = config.profile_key.lock() {
            *key = profile_key;
        }
    }
    let positions = positions.filter(|values| values.len() == 6 && values.iter().all(|value| value.is_finite()));
    let gripper_position = gripper_position.filter(|value| value.is_finite() && *value >= 0.0);
    let error = if !bridge_connected {
        "桌面端尚未连接 Jetson Bridge".into()
    } else if error.trim().is_empty() && positions.is_none() {
        "没有新鲜的关节反馈".into()
    } else {
        error
    };
    if let Ok(mut feedback) = config.feedback.lock() {
        *feedback = FeedbackSnapshot { bridge_connected, positions, gripper_position, error, published_ms: now_ms() };
    }
    let payload = feedback_json(config).to_string();
    broadcast(config, &payload);
}

fn feedback_json(config: &RuntimeConfig) -> Value {
    let Ok(feedback) = config.feedback.lock() else {
        return json!({ "bridgeConnected": false, "error": "桌面端尚未连接 Jetson Bridge" });
    };
    let age_ms = now_ms().saturating_sub(feedback.published_ms);
    json!({
        "bridgeConnected": feedback.bridge_connected,
        "positions": feedback.positions,
        "gripperPosition": feedback.gripper_position,
        "error": feedback.error,
        "ageMs": if feedback.published_ms == 0 { Value::Null } else { json!(age_ms) },
    })
}

fn freeze_capture(config: &RuntimeConfig) -> Result<Value, String> {
    let snapshot = config.feedback.lock().map_err(|_| "姿态库正忙")?.clone();
    if !snapshot.bridge_connected {
        return Err("桌面端尚未连接 Jetson Bridge，手机无法保存姿态".into());
    }
    if snapshot.published_ms == 0 || now_ms().saturating_sub(snapshot.published_ms) > 1500 {
        return Err("桌面端没有新鲜的关节反馈".into());
    }
    if !snapshot.error.is_empty() {
        return Err(snapshot.error);
    }
    let Some(positions) = snapshot.positions else { return Err("没有新鲜的关节反馈".into()); };
    let id = random_token()?;
    let profile_key = current_profile_key(config)?;
    let capture = PendingCapture { id: id.clone(), positions: positions.clone(), gripper_position: snapshot.gripper_position, profile_key, created_ms: now_ms() };
    let mut captures = config.captures.lock().map_err(|_| "姿态库正忙")?;
    captures.retain(|item| now_ms().saturating_sub(item.created_ms) < 120_000);
    captures.push(capture);
    if captures.len() > 8 {
        let extra = captures.len() - 8;
        captures.drain(0..extra);
    }
    Ok(json!({ "captureId": id, "positions": positions, "gripperPosition": snapshot.gripper_position }))
}

fn take_capture(config: &RuntimeConfig, id: &str) -> Result<PendingCapture, String> {
    let mut captures = config.captures.lock().map_err(|_| "姿态库正忙")?;
    let index = captures.iter().position(|item| item.id == id).ok_or("保存快照已失效，请重新点击保存当前姿态")?;
    let capture = captures.remove(index);
    if now_ms().saturating_sub(capture.created_ms) > 120_000 {
        return Err("保存快照已失效，请重新点击保存当前姿态".into());
    }
    Ok(capture)
}

impl Clone for FeedbackSnapshot {
    fn clone(&self) -> Self {
        Self {
            bridge_connected: self.bridge_connected,
            positions: self.positions.clone(),
            gripper_position: self.gripper_position,
            error: self.error.clone(),
            published_ms: self.published_ms,
        }
    }
}

fn request_token(request: &Request) -> String {
    if let Some(header) = request.headers.get("x-teach-token") {
        if !header.is_empty() {
            return header.clone();
        }
    }
    query_value(&request.query, "token").unwrap_or_default()
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (percent_decode(key) == name).then(|| percent_decode(value))
    })
}

fn is_live_socket(request: &Request) -> bool {
    if request.method != "GET" {
        return false;
    }
    let path = sanitize_path(&request.path).unwrap_or_default();
    path == "api/teach/live" && request.headers.get("upgrade").map(|value| value.eq_ignore_ascii_case("websocket")).unwrap_or(false)
}

fn token_matches(expected: &str, given: &str) -> bool {
    let left = expected.as_bytes();
    let right = given.as_bytes();
    if left.len() != right.len() || left.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.iter().zip(right) {
        diff |= a ^ b;
    }
    diff == 0
}

fn sanitize_path(path: &str) -> Result<String, String> {
    let decoded = percent_decode(path);
    if decoded.contains('\\') || decoded.split('/').any(|segment| segment == "..") {
        return Err("路径无效".into());
    }
    Ok(decoded.trim_start_matches('/').to_string())
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&String::from_utf8_lossy(&bytes[index + 1..index + 3]), 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn load_frontend(frontend: &Frontend, path: &str, query: &str) -> Result<(u16, String, Vec<u8>), String> {
    match frontend {
        Frontend::Proxy { host, port } => {
            if !proxy_allowed(path) {
                return Err("页面资源不存在".into());
            }
            let target = if query.is_empty() { format!("/{path}") } else { format!("/{path}?{query}") };
            proxy_get(host, *port, &target)
        }
        Frontend::Files { roots, app } => {
            if let Some(bytes) = read_dist_file(roots, path) {
                return Ok((200, mime_for(path), bytes));
            }
            if let Some(app) = app {
                if let Some(asset) = app.asset_resolver().get(path.to_string()) {
                    let html_fallback = !path.ends_with(".html") && (asset.mime_type.contains("html") || asset.bytes.starts_with(b"<!"));
                    if !html_fallback {
                        let mime = if asset.mime_type.is_empty() { mime_for(path) } else { asset.mime_type };
                        return Ok((200, mime, asset.bytes));
                    }
                }
            }
            Err("页面资源不存在".into())
        }
    }
}

fn read_dist_file(roots: &[PathBuf], path: &str) -> Option<Vec<u8>> {
    for root in roots {
        let Ok(root) = root.canonicalize() else { continue };
        let candidate = root.join(path);
        let Ok(file) = candidate.canonicalize() else { continue };
        if file.starts_with(&root) && file.is_file() {
            if let Ok(bytes) = fs::read(file) {
                return Some(bytes);
            }
        }
    }
    None
}

fn proxy_allowed(path: &str) -> bool {
    path == "index.html"
        || path == "teach"
        || path.starts_with("src/")
        || path.starts_with("assets/")
        || path.starts_with("@vite/")
        || path.starts_with("@react-refresh")
        || path.starts_with("node_modules/")
        || path == "favicon.ico"
}

fn proxy_get(host: &str, port: u16, target: &str) -> Result<(u16, String, Vec<u8>), String> {
    let address = format!("{host}:{port}");
    let mut stream = TcpStream::connect_timeout(&address.parse().map_err(|_| "开发服务器地址无效")?, Duration::from_secs(2))
        .map_err(|_| "开发服务器未启动，无法把姿态页分享到手机".to_string())?;
    stream.set_read_timeout(Some(Duration::from_secs(20))).ok();
    let request = format!("GET {target} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: */*\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|error| format!("无法读取页面资源：{error}"))?;
    read_http_response(&mut stream)
}

fn read_http_response(stream: &mut TcpStream) -> Result<(u16, String, Vec<u8>), String> {
    let header_bytes = read_until(stream, b"\r\n\r\n", 64 * 1024)?;
    let header_text = String::from_utf8_lossy(&header_bytes).to_string();
    let (head, _) = header_text.split_once("\r\n\r\n").unwrap_or((header_text.as_str(), ""));
    let mut lines = head.split("\r\n");
    let status = lines.next().unwrap_or("").split_whitespace().nth(1).and_then(|value| value.parse().ok()).unwrap_or(502);
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }
    let mime = headers.get("content-type").cloned().unwrap_or_else(|| "application/octet-stream".into());
    let body = if headers.get("transfer-encoding").map(|value| value.to_ascii_lowercase().contains("chunked")).unwrap_or(false) {
        read_chunked(stream)?
    } else if let Some(length) = headers.get("content-length").and_then(|value| value.parse::<usize>().ok()) {
        if length > 32 * 1024 * 1024 {
            return Err("页面资源过大".into());
        }
        let mut body = vec![0; length];
        stream.read_exact(&mut body).map_err(|_| "页面资源不完整".to_string())?;
        body
    } else {
        let mut body = Vec::new();
        stream.read_to_end(&mut body).map_err(|error| format!("无法读取页面资源：{error}"))?;
        body
    };
    Ok((status, mime, body))
}

fn read_chunked(stream: &mut TcpStream) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    loop {
        let line = read_until(stream, b"\r\n", 64)?;
        let text = String::from_utf8_lossy(&line);
        let size_text = text.trim_end_matches("\r\n").split(';').next().unwrap_or("0");
        let size = usize::from_str_radix(size_text.trim(), 16).map_err(|_| "分块响应无效")?;
        if size == 0 {
            break;
        }
        if body.len().saturating_add(size) > 32 * 1024 * 1024 {
            return Err("页面资源过大".into());
        }
        let mut chunk = vec![0; size];
        stream.read_exact(&mut chunk).map_err(|_| "分块响应不完整".to_string())?;
        body.extend(chunk);
        let mut crlf = [0u8; 2];
        stream.read_exact(&mut crlf).map_err(|_| "分块响应不完整".to_string())?;
    }
    Ok(body)
}

fn mime_for(path: &str) -> String {
    if path.ends_with(".html") { "text/html; charset=utf-8" }
    else if path.ends_with(".js") || path.ends_with(".mjs") { "text/javascript; charset=utf-8" }
    else if path.ends_with(".css") { "text/css; charset=utf-8" }
    else if path.ends_with(".svg") { "image/svg+xml" }
    else if path.ends_with(".json") { "application/json" }
    else if path.ends_with(".wasm") { "application/wasm" }
    else if path.ends_with(".png") { "image/png" }
    else if path.ends_with(".woff2") { "font/woff2" }
    else { "application/octet-stream" }
    .to_string()
}

fn without_csp_meta(html: &str) -> String {
    if !html.to_ascii_lowercase().contains("content-security-policy") {
        return html.to_string();
    }
    let mut out = String::new();
    let mut rest = html;
    while let Some(start) = rest.to_ascii_lowercase().find("<meta") {
        out.push_str(&rest[..start]);
        let Some(end) = rest[start..].find('>') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let tag = &rest[start..start + end + 1];
        if !tag.to_ascii_lowercase().contains("content-security-policy") {
            out.push_str(tag);
        }
        rest = &rest[start + end + 1..];
    }
    out.push_str(rest);
    out
}

fn handle_websocket(mut stream: TcpStream, config: &RuntimeConfig, request: &Request) {
    let given = request_token(request);
    if !token_matches(&config.token, &given) {
        let _ = stream.write_all(&http_response(401, "application/json; charset=utf-8", json!({ "error": "分享令牌无效" }).to_string().into_bytes()));
        let _ = stream.shutdown(Shutdown::Both);
        return;
    }
    let Some(key) = request.headers.get("sec-websocket-key").cloned() else {
        let _ = stream.write_all(&http_response(400, "application/json; charset=utf-8", json!({ "error": "缺少 WebSocket 握手" }).to_string().into_bytes()));
        return;
    };
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
        websocket_accept(&key)
    );
    if stream.write_all(response.as_bytes()).is_err() {
        return;
    }
    let Ok(writer_stream) = stream.try_clone() else { return };
    let writer = Arc::new(Mutex::new(writer_stream));
    let id = {
        let Ok(mut next) = config.next_listener.lock() else { return };
        let id = *next;
        *next += 1;
        id
    };
    if let Ok(mut listeners) = config.listeners.lock() {
        listeners.push(LiveClient { id, stream: writer.clone() });
    }
    let _ = write_text_frame(&mut writer.lock().unwrap(), &feedback_json(config).to_string());
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    loop {
        if config.stop.load(Ordering::Relaxed) {
            break;
        }
        match read_client_frame(&mut stream) {
            Ok(ClientFrame::Close) => break,
            Ok(ClientFrame::Ping(payload)) => {
                if let Ok(mut sink) = writer.lock() {
                    let _ = write_control_frame(&mut sink, 0xA, &payload);
                }
            }
            Ok(ClientFrame::Ignore) => {}
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(_) => break,
        }
    }
    if let Ok(mut listeners) = config.listeners.lock() {
        listeners.retain(|listener| listener.id != id);
    }
}

enum ClientFrame {
    Close,
    Ping(Vec<u8>),
    Ignore,
}

fn read_client_frame(stream: &mut TcpStream) -> std::io::Result<ClientFrame> {
    let mut header = [0u8; 2];
    stream.read_exact(&mut header)?;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut length = (header[1] & 0x7f) as u64;
    if length == 126 {
        let mut extended = [0u8; 2];
        stream.read_exact(&mut extended)?;
        length = u16::from_be_bytes(extended) as u64;
    } else if length == 127 {
        let mut extended = [0u8; 8];
        stream.read_exact(&mut extended)?;
        length = u64::from_be_bytes(extended);
    }
    if length > MAX_BODY as u64 {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "websocket frame too large"));
    }
    let mut mask = [0u8; 4];
    if masked {
        stream.read_exact(&mut mask)?;
    }
    let mut payload = vec![0; length as usize];
    if length > 0 {
        stream.read_exact(&mut payload)?;
    }
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Ok(match opcode {
        0x8 => ClientFrame::Close,
        0x9 => ClientFrame::Ping(payload),
        _ => ClientFrame::Ignore,
    })
}

fn broadcast(config: &RuntimeConfig, text: &str) {
    let Ok(mut listeners) = config.listeners.lock() else { return };
    listeners.retain(|listener| listener.stream.lock().map(|mut stream| write_text_frame(&mut stream, text).is_ok()).unwrap_or(false));
}

fn write_text_frame(stream: &mut TcpStream, text: &str) -> std::io::Result<()> {
    write_frame(stream, 0x81, text.as_bytes())
}

fn write_control_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    write_frame(stream, 0x80 | opcode, payload)
}

fn write_frame(stream: &mut TcpStream, header: u8, payload: &[u8]) -> std::io::Result<()> {
    let mut frame = vec![header];
    let length = payload.len();
    if length < 126 {
        frame.push(length as u8);
    } else if length < 65536 {
        frame.push(126);
        frame.extend_from_slice(&(length as u16).to_be_bytes());
    } else {
        frame.push(127);
        frame.extend_from_slice(&(length as u64).to_be_bytes());
    }
    frame.extend_from_slice(payload);
    stream.write_all(&frame)
}

fn websocket_accept(key: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64(&hasher.finalize())
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    let mut index = 0;
    while index + 3 <= bytes.len() {
        let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8) | bytes[index + 2] as u32;
        out.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 63) as usize] as char);
        out.push(TABLE[(chunk & 63) as usize] as char);
        index += 3;
    }
    if bytes.len() - index == 1 {
        let chunk = (bytes[index] as u32) << 16;
        out.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        out.push('=');
        out.push('=');
    } else if bytes.len() - index == 2 {
        let chunk = ((bytes[index] as u32) << 16) | ((bytes[index + 1] as u32) << 8);
        out.push(TABLE[((chunk >> 18) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 12) & 63) as usize] as char);
        out.push(TABLE[((chunk >> 6) & 63) as usize] as char);
        out.push('=');
    }
    out
}

fn http_response(status: u16, mime: &str, body: Vec<u8>) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        201 => "Created",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        409 => "Conflict",
        _ => "Error",
    };
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n",
        body.len()
    );
    let mut response = header.into_bytes();
    response.extend(body);
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn share_url_stays_on_the_desk_and_does_not_embed_the_jetson_bridge() {
        let url = format_teach_share_url("10.0.0.8", 17420, "abc");
        assert_eq!(url, "http://10.0.0.8:17420/teach?token=abc");
        assert!(!url.contains("bridge="));
        assert!(!url.contains("jetson"));
        assert!(!url.contains("8765"));
        assert_eq!(websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    }

    #[test]
    fn strips_desktop_csp_so_the_phone_can_socket_back_to_the_desk() {
        let html = r#"<head><meta http-equiv="Content-Security-Policy" content="connect-src 'self' ws://127.0.0.1:*"><meta charset="utf-8"></head>"#;
        let cleaned = without_csp_meta(html);
        assert!(!cleaned.to_ascii_lowercase().contains("content-security-policy"));
        assert!(cleaned.contains("charset"));
    }

    #[test]
    fn lan_listener_binds_all_ipv4_interfaces_and_pose_api_writes_the_desk_file() {
        let dir = std::env::temp_dir().join(format!("teach-share-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("www")).unwrap();
        fs::write(dir.join("www/index.html"), "<title>姿态库</title><meta http-equiv=\"Content-Security-Policy\" content=\"connect-src ws://127.0.0.1:*\">").unwrap();
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        assert_eq!(listener.local_addr().unwrap().ip(), IpAddr::V4(Ipv4Addr::UNSPECIFIED));
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let changes = Arc::new(AtomicUsize::new(0));
        let changes_cb = changes.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let config = Arc::new(RuntimeConfig {
            token: "abc".into(),
            profile_key: Mutex::new("jetson|op|22".into()),
            positions_path: positions::positions_file(&dir),
            frontend: Frontend::Files { roots: vec![dir.join("www")], app: None },
            on_change: Arc::new(move || { changes_cb.fetch_add(1, Ordering::Relaxed); }),
            file_lock: Mutex::new(()),
            feedback: Mutex::new(disconnected_feedback()),
            captures: Mutex::new(Vec::new()),
            listeners: Mutex::new(Vec::new()),
            next_listener: Mutex::new(1),
            stop: stop.clone(),
        });
        let server = config.clone();
        let thread = thread::spawn(move || accept_loop(listener, server));
        let (status, body) = exchange(port, "GET", "/teach?token=abc", None, None);
        assert_eq!(status, 200);
        assert!(body.contains("姿态库"));
        assert!(!body.to_ascii_lowercase().contains("content-security-policy"));
        let (status, body) = exchange(port, "POST", "/api/teach/capture", Some("abc"), Some("{}"));
        assert_eq!(status, 409, "{body}");
        assert!(body.contains("尚未连接"));
        let (status, body) = exchange(port, "POST", "/api/teach/poses", Some("abc"), Some(r#"{"name":"伪造","captureId":"nope","positions":[9,9,9,9,9,9]}"#));
        assert_ne!(status, 201, "{body}");
        publish_feedback(&config, true, "jetson|op|22".into(), Some(vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), Some(0.02), String::new());
        let (status, body) = exchange(port, "GET", "/api/teach/feedback", Some("abc"), None);
        assert_eq!(status, 200, "{body}");
        assert!(body.contains("0.1"));
        assert!(body.contains("\"bridgeConnected\":true"));
        let (status, body) = exchange(port, "POST", "/api/teach/capture", Some("abc"), Some("{}"));
        assert_eq!(status, 200, "{body}");
        let capture_id = body.split("\"captureId\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();
        publish_feedback(&config, true, "jetson|op|22".into(), Some(vec![1.0, 1.0, 1.0, 1.0, 1.0, 1.0]), None, String::new());
        let payload = format!(r#"{{"name":"手机位","captureId":"{capture_id}","positions":[9,9,9,9,9,9],"note":"tap","gripperPosition":0.09}}"#);
        let (status, body) = exchange(port, "POST", "/api/teach/poses", Some("abc"), Some(&payload));
        assert_eq!(status, 201, "{body}");
        let saved_pose: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(saved_pose["position"]["name"], "手机位");
        assert_eq!(saved_pose["position"]["positions"], json!([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
        assert_eq!(saved_pose["position"]["gripperPosition"], json!(0.02));
        let (status, body) = exchange(port, "POST", "/api/teach/capture", Some("abc"), Some("{}"));
        assert_eq!(status, 200, "{body}");
        let omitted_id = body.split("\"captureId\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();
        let omitted = format!(r#"{{"name":"无夹爪","captureId":"{omitted_id}","gripperPosition":0.09}}"#);
        let (status, body) = exchange(port, "POST", "/api/teach/poses", Some("abc"), Some(&omitted));
        assert_eq!(status, 201, "{body}");
        let omitted_pose: Value = serde_json::from_str(&body).unwrap();
        assert!(omitted_pose["position"].get("gripperPosition").is_none());
        publish_feedback(&config, true, "jetson|op|22".into(), Some(vec![0.1, 0.2, 0.3, 0.4, 0.5, 0.6]), Some(0.02), String::new());
        let (status, body) = exchange(port, "POST", "/api/teach/capture", Some("abc"), Some("{}"));
        assert_eq!(status, 200, "{body}");
        let unchecked_id = body.split("\"captureId\":\"").nth(1).unwrap().split('"').next().unwrap().to_string();
        let unchecked = format!(r#"{{"name":"不保存夹爪","captureId":"{unchecked_id}"}}"#);
        let (status, body) = exchange(port, "POST", "/api/teach/poses", Some("abc"), Some(&unchecked));
        assert_eq!(status, 201, "{body}");
        let unchecked_pose: Value = serde_json::from_str(&body).unwrap();
        assert!(unchecked_pose["position"].get("gripperPosition").is_none());
        assert_eq!(changes.load(Ordering::Relaxed), 3);
        let saved: Value = serde_json::from_str(&fs::read_to_string(positions::positions_file(&dir)).unwrap()).unwrap();
        let stored = &saved["profiles"]["jetson|op|22"]["positions"];
        assert_eq!(stored[0]["gripperPosition"], json!(0.02));
        assert_eq!(stored[0]["positions"], json!([0.1, 0.2, 0.3, 0.4, 0.5, 0.6]));
        assert!(stored[1].get("gripperPosition").is_none());
        assert!(stored[2].get("gripperPosition").is_none());
        assert!(!saved.to_string().contains("builtin:home"));
        assert!(!saved.to_string().contains("0.09"));
        let frame = live_frame(port);
        assert!(frame.contains("1.0") || frame.contains("0.1"));
        assert!(!frame.contains("8765"));
        stop.store(true, Ordering::Relaxed);
        thread.join().unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    fn live_frame(port: u16) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let request = "GET /api/teach/live?token=abc HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
        stream.write_all(request.as_bytes()).unwrap();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        let started = std::time::Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => buf.extend_from_slice(&chunk[..count]),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::TimedOut => {
                    if String::from_utf8_lossy(&buf).contains("bridgeConnected") { break; }
                    continue;
                }
                Err(_) => break,
            }
            if String::from_utf8_lossy(&buf).contains("bridgeConnected") { break; }
        }
        String::from_utf8_lossy(&buf).into_owned()
    }

    fn exchange(port: u16, method: &str, path: &str, token: Option<&str>, body: Option<&str>) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let body = body.unwrap_or("");
        let token = token.map(|value| format!("X-Teach-Token: {value}\r\n")).unwrap_or_default();
        let length = if method == "POST" { format!("Content-Length: {}\r\n", body.len()) } else { String::new() };
        let request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n{token}{length}\r\n{body}");
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        let status = response.split_whitespace().nth(1).unwrap().parse().unwrap();
        let body = response.split("\r\n\r\n").nth(1).unwrap_or("").to_string();
        (status, body)
    }
}
