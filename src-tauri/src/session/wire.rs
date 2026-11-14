use serde_json::Value;
use std::sync::Arc;

pub const MAX_FRAME_BYTES: usize = 80 * 1024 * 1024;
pub const MAX_METADATA_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub struct WireFrame {
    pub bytes: Arc<[u8]>,
    pub binary: bool,
    pub metadata: Value,
    pub source_age_ms: u64,
}

impl WireFrame {
    pub fn parse(bytes: Arc<[u8]>, binary: bool) -> Result<Self, String> {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err("Bridge 帧超过大小上限".into());
        }
        let (metadata, payload_len) = if binary {
            if bytes.len() < 8 {
                return Err("Bridge 二进制帧头不完整".into());
            }
            let magic = &bytes[..4];
            let expected = match magic {
                b"RCI1" => "topic_message",
                b"RCR1" => "resource",
                b"RCD1" => "rgbd_frame",
                b"RCT1" => "visual_target_frame",
                _ => return Err("未知的 Bridge 二进制帧".into()),
            };
            let size = u32::from_be_bytes(bytes[4..8].try_into().unwrap()) as usize;
            if size > MAX_METADATA_BYTES || size > bytes.len() - 8 {
                return Err("Bridge 二进制元数据长度无效".into());
            }
            let meta: Value = serde_json::from_slice(&bytes[8..8 + size])
                .map_err(|e| format!("Bridge 元数据无效：{e}"))?;
            if meta.get("op").and_then(Value::as_str) != Some(expected) {
                return Err("Bridge 帧类型不匹配".into());
            }
            (meta, Some(bytes.len() - 8 - size))
        } else {
            (
                serde_json::from_slice(&bytes).map_err(|e| format!("Bridge JSON 无效：{e}"))?,
                None,
            )
        };
        if !metadata.is_object()
            || metadata
                .get("op")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .is_none()
        {
            return Err("Bridge 消息缺少 op".into());
        }
        if let Some(length) = payload_len {
            let declared = if metadata["op"] == "topic_message" {
                &metadata["data"]["data_length"]
            } else {
                &metadata["data_length"]
            };
            if declared.as_u64() != Some(length as u64) {
                return Err("Bridge 数据长度不匹配".into());
            }
        }
        Ok(Self {
            bytes,
            binary,
            metadata,
            source_age_ms: 0,
        })
    }
    pub fn op(&self) -> &str {
        self.metadata["op"].as_str().unwrap_or("")
    }
    pub fn request_id(&self) -> Option<&str> {
        self.metadata["request_id"]
            .as_str()
            .filter(|v| !v.is_empty())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binary(magic: &[u8; 4], meta: Value, data: &[u8]) -> Arc<[u8]> {
        let metadata = serde_json::to_vec(&meta).unwrap();
        let mut bytes = Vec::from(*magic);
        bytes.extend((metadata.len() as u32).to_be_bytes());
        bytes.extend(metadata);
        bytes.extend(data);
        bytes.into()
    }
    #[test]
    fn preserves_binary_payload_and_validates_all_four_formats() {
        for (magic, op) in [
            (b"RCI1", "topic_message"),
            (b"RCR1", "resource"),
            (b"RCD1", "rgbd_frame"),
            (b"RCT1", "visual_target_frame"),
        ] {
            let meta = if op == "topic_message" {
                serde_json::json!({"op":op,"data":{"data_length":3}})
            } else {
                serde_json::json!({"op":op,"data_length":3})
            };
            let data = binary(magic, meta, &[1, 2, 255]);
            let frame = WireFrame::parse(data.clone(), true).unwrap();
            assert!(Arc::ptr_eq(&frame.bytes, &data));
            assert_eq!(frame.op(), op);
            assert!(frame.binary);
        }
    }
    #[test]
    fn rejects_corrupt_or_confused_envelopes() {
        assert!(WireFrame::parse(Arc::from(&b"RCI1"[..]), true).is_err());
        assert!(WireFrame::parse(
            binary(
                b"RCD1",
                serde_json::json!({"op":"resource","data_length":0}),
                &[]
            ),
            true
        )
        .is_err());
        assert!(WireFrame::parse(
            binary(
                b"RCR1",
                serde_json::json!({"op":"resource","data_length":2}),
                &[0]
            ),
            true
        )
        .is_err());
        assert!(WireFrame::parse(Arc::from(&b"[]"[..]), false).is_err());
        assert!(WireFrame::parse(Arc::from(&b"{\"op\":3}"[..]), false).is_err());
    }
}
