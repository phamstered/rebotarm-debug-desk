//! Resolve the deployment runtime without depending on a GUI login-shell PATH.
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use tokio::process::Command;

pub struct NodeRuntime {
    pub program: PathBuf,
    path: OsString,
}

impl NodeRuntime {
    pub fn command(&self, root: &Path) -> Command {
        let mut command = Command::new(&self.program);
        command.current_dir(root).env("PATH", &self.path);
        command
    }
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

// Dependencies are explicit so tests never mutate process-wide environment.
fn resolve(
    override_node: Option<&OsStr>,
    path: Option<&OsStr>,
    fallback_dirs: &[PathBuf],
    root: &Path,
) -> Result<NodeRuntime, String> {
    let absolute = |path: PathBuf| {
        if path.is_absolute() {
            path
        } else {
            root.join(path)
        }
    };
    let path_dirs: Vec<PathBuf> = path
        .map(std::env::split_paths)
        .into_iter()
        .flatten()
        .filter(|entry| !entry.as_os_str().is_empty())
        .map(absolute)
        .collect();
    let candidates: Vec<PathBuf> = if let Some(value) = override_node {
        if value.is_empty() {
            return Err("NODE_BINARY 已设置但为空，请指定 Node 可执行文件".into());
        }
        let value = PathBuf::from(value);
        if value.is_absolute() || value.components().count() > 1 {
            vec![absolute(value)]
        } else {
            path_dirs
                .iter()
                .chain(fallback_dirs)
                .map(|dir| dir.join(&value))
                .collect()
        }
    } else {
        path_dirs
            .iter()
            .chain(fallback_dirs)
            .map(|dir| dir.join("node"))
            .collect()
    };
    let program = candidates.into_iter().find(|candidate| executable(candidate)).ok_or_else(|| {
        if override_node.is_some() {
            "NODE_BINARY 指定的 Node 不存在或不可执行；请修正配置（不会静默改用其他 Node）".to_string()
        } else {
            "未找到 Node.js 可执行文件：已检查 PATH 和常见安装目录。请安装 Node.js，或通过 NODE_BINARY 指定绝对路径".to_string()
        }
    })?;
    // This is a child-only PATH. Keep the selected install directory (not its
    // canonical Cellar target), so /usr/bin/env node and script helpers work.
    let mut child_dirs = vec![program.parent().unwrap().to_path_buf()];
    for dir in path_dirs.iter().chain(fallback_dirs) {
        if !child_dirs.contains(dir) {
            child_dirs.push(dir.clone());
        }
    }
    for dir in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
        let dir = PathBuf::from(dir);
        if !child_dirs.contains(&dir) {
            child_dirs.push(dir);
        }
    }
    let path = std::env::join_paths(child_dirs).map_err(|e| format!("部署 PATH 无效：{e}"))?;
    Ok(NodeRuntime { program, path })
}

pub fn deployment_node(root: &Path) -> Result<NodeRuntime, String> {
    let fallback = if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]
    } else {
        Vec::new()
    };
    resolve(
        std::env::var_os("NODE_BINARY").as_deref(),
        std::env::var_os("PATH").as_deref(),
        &fallback,
        root,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "node-runtime-{}-{}",
                std::process::id(),
                SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn binary(&self, relative: &str, runnable: bool) -> PathBuf {
            let path = self.0.join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(
                    &path,
                    std::fs::Permissions::from_mode(if runnable { 0o755 } else { 0o644 }),
                )
                .unwrap();
            }
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn gui_path_uses_fallback_and_prepares_child_helpers() {
        let f = Fixture::new();
        let node = f.binary("homebrew/bin/node", true);
        let dir = node.parent().unwrap().to_path_buf();
        let runtime = resolve(
            None,
            Some(OsStr::new("/usr/bin:/bin")),
            &[dir.clone()],
            &f.0,
        )
        .unwrap();
        assert_eq!(runtime.program, node);
        let dirs: Vec<_> = std::env::split_paths(&runtime.path).collect();
        assert_eq!(dirs[0], dir);
        assert!(dirs.contains(&PathBuf::from("/usr/bin")));
    }
    #[test]
    fn path_precedes_fallback_and_explicit_override_precedes_path() {
        let f = Fixture::new();
        let path_node = f.binary("path/node", true);
        let fallback = f.binary("fallback/node", true);
        let explicit = f.binary("custom install/node", true);
        let path = path_node.parent().unwrap().as_os_str();
        let fallback_dir = fallback.parent().unwrap().to_path_buf();
        assert_eq!(
            resolve(None, Some(path), &[fallback_dir.clone()], &f.0)
                .unwrap()
                .program,
            path_node
        );
        assert_eq!(
            resolve(
                Some(explicit.as_os_str()),
                Some(path),
                &[fallback_dir],
                &f.0
            )
            .unwrap()
            .program,
            explicit
        );
    }
    #[test]
    fn invalid_explicit_override_never_silently_falls_back() {
        let f = Fixture::new();
        let valid = f.binary("bin/node", true);
        let invalid = f.binary("no-execute", false);
        for value in [
            OsStr::new(""),
            OsStr::new("missing"),
            invalid.as_os_str(),
            f.0.as_os_str(),
        ] {
            assert!(resolve(
                Some(value),
                Some(valid.parent().unwrap().as_os_str()),
                &[],
                &f.0
            )
            .is_err());
        }
    }
    #[test]
    fn bare_override_and_relative_override_are_single_executables() {
        let f = Fixture::new();
        let node = f.binary("bin/node22", true);
        assert_eq!(
            resolve(
                Some(OsStr::new("node22")),
                Some(node.parent().unwrap().as_os_str()),
                &[],
                &f.0
            )
            .unwrap()
            .program,
            node
        );
        assert_eq!(
            resolve(Some(OsStr::new("bin/node22")), None, &[], &f.0)
                .unwrap()
                .program,
            node
        );
        assert!(resolve(Some(OsStr::new("node22 --eval malicious")), None, &[], &f.0).is_err());
        assert!(resolve(None, None, &[], &f.0).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn follows_valid_install_symlink_but_rejects_broken_links() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let target = f.binary("Cellar/node", true);
        let bin = f.0.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        symlink(&target, bin.join("node")).unwrap();
        assert_eq!(
            resolve(None, None, &[bin.clone()], &f.0).unwrap().program,
            bin.join("node")
        );
        std::fs::remove_file(target).unwrap();
        assert!(resolve(None, None, &[bin], &f.0).is_err());
    }
    #[tokio::test]
    async fn real_deploy_script_starts_with_gui_environment_and_spaced_runtime_path() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
        let installed =
            deployment_node(&root).expect("Node is required to run the project test suite");
        let f = Fixture::new();
        let bin = f.0.join("Node install with spaces");
        std::fs::create_dir_all(&bin).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&installed.program, bin.join("node")).unwrap();
        #[cfg(not(unix))]
        std::fs::copy(&installed.program, bin.join("node")).unwrap();
        let runtime = resolve(
            None,
            Some(OsStr::new("")), // Stricter than a GUI PATH: no Node can be found there.
            &[bin.clone()],
            &root,
        )
        .unwrap();
        assert_eq!(runtime.program, bin.join("node"));
        let output = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            runtime
                .command(&root)
                .env_clear()
                .env("PATH", &runtime.path)
                .arg("scripts/deploy-bridge.mjs")
                .arg("--help")
                .output(),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout)
            .contains("Usage: node scripts/deploy-bridge.mjs"));
    }
}
