use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "positions.v1.json";
const EMPTY: &str = r#"{"schemaVersion":1,"profiles":{}}"#;

pub fn validate_positions_json(text: &str) -> Result<(), String> {
    let value: Value = serde_json::from_str(text).map_err(|error| format!("点位文件不是有效 JSON：{error}"))?;
    let root = value.as_object().ok_or("点位文件必须是对象")?;
    if root.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("不支持的点位文件版本".into());
    }
    let profiles = root.get("profiles").and_then(Value::as_object).ok_or("缺少 profiles")?;
    for (key, profile) in profiles {
        if key.is_empty() || key.len() > 512 || key.chars().any(|ch| ch.is_control()) {
            return Err("连接键无效".into());
        }
        let positions = profile.get("positions").and_then(Value::as_array).ok_or("positions 必须是数组")?;
        let mut names = std::collections::BTreeSet::new();
        for item in positions {
            let id = item.get("id").and_then(Value::as_str).unwrap_or("");
            if id == "builtin:home" {
                return Err("不能保存 HOME".into());
            }
            let name = item.get("name").and_then(Value::as_str).unwrap_or("").trim();
            if name.is_empty() || name == "HOME" {
                return Err("点位名称无效".into());
            }
            if !names.insert(name.to_string()) {
                return Err("点位名称重复".into());
            }
            let joints = item.get("positions").and_then(Value::as_array).ok_or("关节值无效")?;
            if joints.len() != 6 {
                return Err("关节数量必须是 6".into());
            }
            for joint in joints {
                let number = joint.as_f64().ok_or("关节值必须是有限数值")?;
                if !number.is_finite() {
                    return Err("关节值必须是有限数值".into());
                }
            }
        }
    }
    Ok(())
}

pub fn positions_file(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

pub fn read_positions_file(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(EMPTY.into());
    }
    let text = fs::read_to_string(path).map_err(|error| format!("无法读取点位文件：{error}"))?;
    validate_positions_json(&text)?;
    Ok(text)
}

pub fn write_positions_file(path: &Path, text: &str) -> Result<(), String> {
    validate_positions_json(text)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建点位目录：{error}"))?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, text).map_err(|error| format!("无法写入点位文件：{error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("无法保存点位文件：{error}"))?;
    Ok(())
}

fn store_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(positions_file(&dir))
}

#[tauri::command]
pub fn positions_load(app: AppHandle) -> Result<String, String> {
    read_positions_file(&store_path(&app)?)
}

#[tauri::command]
pub fn positions_save(app: AppHandle, content: String) -> Result<(), String> {
    write_positions_file(&store_path(&app)?, &content)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_home_and_accepts_a_custom_point() {
        assert!(validate_positions_json(EMPTY).is_ok());
        let home = serde_json::json!({
            "schemaVersion": 1,
            "profiles": { "jetson|robot|22": { "positions": [{
                "id": "builtin:home",
                "name": "HOME",
                "positions": [0, 0, 0, 0, 0, 0]
            }] } }
        });
        assert!(validate_positions_json(&home.to_string()).unwrap_err().contains("HOME"));
        let custom = serde_json::json!({
            "schemaVersion": 1,
            "profiles": { "jetson|robot|22": { "positions": [{
                "id": "id-1",
                "name": "取料位",
                "positions": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
            }] } }
        });
        assert!(validate_positions_json(&custom.to_string()).is_ok());
    }

    #[test]
    fn writes_atomically_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("positions-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = positions_file(&dir);
        let text = serde_json::json!({
            "schemaVersion": 1,
            "profiles": {}
        }).to_string();
        write_positions_file(&path, &text).unwrap();
        assert_eq!(read_positions_file(&path).unwrap(), text);
        assert!(write_positions_file(&path, "{\"schemaVersion\":1}").is_err());
        assert_eq!(read_positions_file(&path).unwrap(), text);
        let _ = fs::remove_dir_all(&dir);
    }
}
