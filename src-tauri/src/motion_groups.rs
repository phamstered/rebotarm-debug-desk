use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};
static STORE_LOCK: Mutex<()> = Mutex::new(());
const EMPTY: &str = r#"{"schemaVersion":1,"profiles":{}}"#;
const MAX_BYTES: u64 = 4 * 1024 * 1024;
fn object<'a>(v: &'a Value, keys: &[&str]) -> Result<&'a serde_json::Map<String, Value>, String> {
    let o = v.as_object().ok_or("动作组必须是对象")?;
    if o.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err("动作组含未知字段".into());
    }
    Ok(o)
}
fn text<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let s = v
        .get(key)
        .and_then(Value::as_str)
        .ok_or("动作组字符串无效")?;
    if s.trim().is_empty() || s.len() > max || s.chars().any(|c| c.is_control()) {
        return Err("动作组字符串无效".into());
    }
    Ok(s)
}
fn number(v: &Value, key: &str) -> Result<f64, String> {
    let n = v.get(key).and_then(Value::as_f64).ok_or("动作组数值无效")?;
    if !n.is_finite() {
        return Err("动作组数值必须有限".into());
    }
    Ok(n)
}
pub fn validate_motion_groups_json(raw: &str) -> Result<(), String> {
    if raw.len() as u64 > MAX_BYTES {
        return Err("动作组文件超过 4 MiB".into());
    }
    let v: Value = serde_json::from_str(raw).map_err(|e| format!("动作组 JSON 无效：{e}"))?;
    object(&v, &["schemaVersion", "profiles"])?;
    if v["schemaVersion"].as_u64() != Some(1) {
        return Err("动作组版本无效".into());
    }
    let profiles = v["profiles"].as_object().ok_or("动作组 profiles 无效")?;
    if profiles.len() > 32 {
        return Err("连接配置过多".into());
    }
    for (key, profile) in profiles {
        if key.trim().is_empty()
            || key.len() > 512
            || key.chars().any(|c| c.is_control())
            || ["__proto__", "constructor", "prototype"].contains(&key.as_str())
        {
            return Err("连接键无效".into());
        }
        object(profile, &["groups"])?;
        let groups = profile["groups"].as_array().ok_or("groups 必须为数组")?;
        if groups.len() > 100 {
            return Err("动作组过多".into());
        }
        let mut ids = BTreeSet::new();
        let mut names = BTreeSet::new();
        for g in groups {
            object(
                g,
                &[
                    "id",
                    "name",
                    "note",
                    "preparationDuration",
                    "steps",
                    "createdAt",
                    "updatedAt",
                ],
            )?;
            let id = text(g, "id", 128)?;
            let name = text(g, "name", 512)?;
            if name != name.trim() || !ids.insert(id) || !names.insert(name) {
                return Err("动作组 ID 或名称重复/无效".into());
            }
            let note = g["note"].as_str().ok_or("备注无效")?;
            if note.encode_utf16().count() > 4000 || note.contains('\0') {
                return Err("备注无效".into());
            }
            if number(g, "createdAt")? < 0. || number(g, "updatedAt")? < 0. {
                return Err("时间戳无效".into());
            }
            let mut total = number(g, "preparationDuration")?;
            if total <= 0. {
                return Err("准备时长必须为正数".into());
            }
            let steps = g["steps"].as_array().ok_or("steps 必须为数组")?;
            if steps.is_empty() || steps.len() > 100 {
                return Err("关键帧数量须在 1..100".into());
            }
            let mut step_ids = BTreeSet::new();
            for (i, s) in steps.iter().enumerate() {
                object(
                    s,
                    &[
                        "id",
                        "positionId",
                        "positionName",
                        "positionUpdatedAt",
                        "positions",
                        "gripperPosition",
                        "duration",
                        "hold",
                    ],
                )?;
                if !step_ids.insert(text(s, "id", 128)?) {
                    return Err("关键帧 ID 重复".into());
                }
                text(s, "positionId", 128)?;
                text(s, "positionName", 512)?;
                if number(s, "positionUpdatedAt")? < 0. {
                    return Err("点位版本无效".into());
                }
                let joints = s["positions"].as_array().ok_or("关节数组无效")?;
                if joints.len() != 6
                    || joints
                        .iter()
                        .any(|n| !n.as_f64().map(|x| x.is_finite()).unwrap_or(false))
                {
                    return Err("必须包含六个有限关节值".into());
                }
                if s.get("gripperPosition").is_some() && number(s, "gripperPosition")? < 0. {
                    return Err("夹爪值无效".into());
                }
                let duration = number(s, "duration")?;
                let hold = number(s, "hold")?;
                if (i == 0 && duration != 0.) || (i > 0 && duration <= 0.) || hold < 0. {
                    return Err("运动/停留时长无效".into());
                }
                total += duration + hold;
            }
            if !total.is_finite() || total > 604800. {
                return Err("动作组总时长不能超过 7 天".into());
            }
        }
    }
    Ok(())
}
pub fn motion_groups_file(dir: &Path) -> PathBuf {
    dir.join("motion-groups.v1.json")
}
fn read_unlocked(path: &Path) -> Result<String, String> {
    let metadata = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(EMPTY.into()),
        Err(e) => return Err(format!("无法读取动作组文件：{e}")),
    };
    if metadata.len() > MAX_BYTES {
        return Err("动作组文件超过 4 MiB".into());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("无法读取动作组文件：{e}"))?;
    validate_motion_groups_json(&raw)?;
    Ok(raw)
}
pub fn read_motion_groups_file(path: &Path) -> Result<String, String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "动作组存储锁无效")?;
    read_unlocked(path)
}
pub fn write_motion_groups_file(path: &Path, raw: &str) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().map_err(|_| "动作组存储锁无效")?;
    validate_motion_groups_json(raw)?;
    read_unlocked(path)?; // Corrupt/inaccessible existing data is never overwritten.
    let parent = path.parent().ok_or("动作组目录无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(
        ".motion-groups-{}-{suffix}.tmp",
        std::process::id()
    ));
    let result = (|| {
        let mut f = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        f.write_all(raw.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
        fs::rename(&temporary, path).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(motion_groups_file(
        &app.path().app_data_dir().map_err(|e| e.to_string())?,
    ))
}
#[tauri::command]
pub fn motion_groups_load(app: AppHandle) -> Result<String, String> {
    read_motion_groups_file(&path(&app)?)
}
#[tauri::command]
pub fn motion_groups_save(app: AppHandle, content: String) -> Result<(), String> {
    write_motion_groups_file(&path(&app)?, &content)
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Value {
        serde_json::json!({"schemaVersion":1,"profiles":{"p":{"groups":[{"id":"g","name":"组","note":"","preparationDuration":5,"createdAt":0,"updatedAt":0,"steps":[{"id":"s","positionId":"p","positionName":"P","positionUpdatedAt":0,"positions":[0,0,0,0,0,0],"duration":0,"hold":0}]}]}}})
    }
    #[test]
    fn validates_contract_and_boundaries() {
        let v = fixture();
        assert!(validate_motion_groups_json(&v.to_string()).is_ok());
        for (k, bad) in [
            ("duration", serde_json::json!(1)),
            ("hold", serde_json::json!(-1)),
            ("positions", serde_json::json!([0, 0])),
        ] {
            let mut x = v.clone();
            x["profiles"]["p"]["groups"][0]["steps"][0][k] = bad;
            assert!(validate_motion_groups_json(&x.to_string()).is_err());
        }
        let mut x = v.clone();
        x["profiles"]["p"]["groups"][0]["steps"][0]["gripperPosition"] = Value::Null;
        assert!(validate_motion_groups_json(&x.to_string()).is_err());
    }
    #[test]
    fn corrupt_file_is_preserved() {
        let dir = std::env::temp_dir().join(format!("motion-groups-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = motion_groups_file(&dir);
        fs::write(&p, "broken").unwrap();
        assert!(read_motion_groups_file(&p).is_err());
        assert!(write_motion_groups_file(&p, EMPTY).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), "broken");
        fs::remove_file(&p).unwrap();
        write_motion_groups_file(&p, &fixture().to_string()).unwrap();
        assert!(read_motion_groups_file(&p).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_duplicates_and_preserves_good_file_on_invalid_update() {
        let good = fixture();
        let mut bad = good.clone();
        let duplicate = bad["profiles"]["p"]["groups"][0].clone();
        bad["profiles"]["p"]["groups"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
        assert!(validate_motion_groups_json(&bad.to_string()).is_err());
        bad = good.clone();
        bad["profiles"]["p"]["groups"][0]["preparationDuration"] = serde_json::json!(604801);
        assert!(validate_motion_groups_json(&bad.to_string()).is_err());
        let dir = std::env::temp_dir().join(format!(
            "motion-groups-invalid-update-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let p = motion_groups_file(&dir);
        write_motion_groups_file(&p, &good.to_string()).unwrap();
        assert!(write_motion_groups_file(&p, &bad.to_string()).is_err());
        assert_eq!(read_motion_groups_file(&p).unwrap(), good.to_string());
        fs::remove_dir_all(dir).unwrap();
    }
}
