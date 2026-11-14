//! Shared private, bounded and crash-durable storage for native recovery journals.
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

#[cfg(test)]
thread_local! {
    static BEFORE_WRITE: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(super) fn before_write_for_test(hook: impl FnOnce() + 'static) {
    BEFORE_WRITE.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
}

pub fn read(path: &Path, limit: u64) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        result => result.map_err(|e| e.to_string())?,
    };
    if !metadata.is_file() || metadata.len() > limit {
        return Err("恢复文件类型或大小无效".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("恢复文件超出大小限制".into());
    }
    Ok(Some(bytes))
}
pub fn write(path: &Path, bytes: &[u8], limit: usize) -> Result<(), String> {
    if bytes.len() > limit {
        return Err("恢复文件超出大小限制".into());
    }
    #[cfg(test)]
    BEFORE_WRITE.with(|slot| {
        if let Some(hook) = slot.borrow_mut().take() {
            hook();
        }
    });
    let parent = path.parent().ok_or("恢复文件目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", super::controller_journal::new_id()?));
    let result = (|| -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result.map_err(|e| format!("恢复记录落盘失败：{e}"))
}
