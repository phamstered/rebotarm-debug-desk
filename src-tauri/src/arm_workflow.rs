use serde::Serialize;
use tauri::ipc::Channel;
use tokio::{io::{AsyncBufReadExt, BufReader}, process::Command};
use std::process::Stdio;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub stage: String,
    pub message: String,
    pub failed: bool,
}

pub fn stage_line(line: &str) -> Option<Progress> {
    let rest = line.strip_prefix("ARM_STAGE|")?;
    let (stage, message) = rest.split_once('|')?;
    if !["prepare", "safe-stop", "cleanup", "startup", "verify", "planner", "ready"].contains(&stage) { return None; }
    Some(Progress { stage: stage.into(), message: message.chars().take(512).collect(), failed: false })
}

fn tail_push(buffer: &mut String, line: &str) {
    buffer.push_str(line); buffer.push('\n');
    if buffer.len() > 16_384 {
        let mut cut = buffer.len() - 16_384;
        while !buffer.is_char_boundary(cut) { cut += 1; }
        buffer.drain(..cut);
    }
}

pub async fn run(command: &mut Command, progress: Option<Channel<Progress>>) -> Result<(bool, i32, String, String), String> {
    let mut child = command.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("无法执行 arm mode：{e}"))?;
    let mut out = BufReader::new(child.stdout.take().ok_or("缺少标准输出")?).lines();
    let mut err = BufReader::new(child.stderr.take().ok_or("缺少错误输出")?).lines();
    let mut stdout = String::new(); let mut stderr = String::new();
    let mut out_done = false; let mut err_done = false;
    let mut current = Progress { stage: "prepare".into(), message: "连接 Jetson 控制环境".into(), failed: false };
    if let Some(channel) = &progress { let _ = channel.send(current.clone()); }
    while !out_done || !err_done {
        tokio::select! {
            line = out.next_line(), if !out_done => match line.map_err(|e| e.to_string())? {
                Some(line) => {
                    if let Some(event) = stage_line(&line) {
                        current = event;
                        if let Some(channel) = &progress { let _ = channel.send(current.clone()); }
                    } else { tail_push(&mut stdout, &line); }
                },
                None => out_done = true,
            },
            line = err.next_line(), if !err_done => match line.map_err(|e| e.to_string())? {
                Some(line) => tail_push(&mut stderr, &line),
                None => err_done = true,
            },
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    current.failed = !status.success();
    if status.success() { current.stage = "ready".into(); current.message = "操作完成，状态核验通过".into(); }
    else { current.message = stderr.lines().last().unwrap_or("远端步骤失败，请查看错误详情").chars().take(512).collect(); }
    if let Some(channel) = &progress { let _ = channel.send(current); }
    Ok((status.success(), status.code().unwrap_or(1), stdout, stderr))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_only_real_allowlisted_stage_markers() {
        assert_eq!(stage_line("ARM_STAGE|cleanup|关闭旧进程").unwrap().stage, "cleanup");
        assert!(stage_line("old output ARM_STAGE|ready|x").is_none());
        assert!(stage_line("ARM_STAGE|unknown|x").is_none());
        let mut tail = String::new();
        tail_push(&mut tail, &"中文".repeat(10_000));
        assert!(tail.len() <= 16_384); assert!(tail.ends_with('\n'));
    }
}
