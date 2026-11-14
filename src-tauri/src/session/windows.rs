use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Page {
    Status,
    Dashboard,
    Motion,
    Monitor,
    Collection,
    Handeye,
    Motor,
    Calibration,
    Gravity,
}

impl Page {
    pub fn title(self) -> &'static str {
        match self {
            Self::Status => "Status",
            Self::Dashboard => "Topics",
            Self::Motion => "Motion",
            Self::Monitor => "Monitor",
            Self::Collection => "数据采集",
            Self::Handeye => "手眼标定",
            Self::Motor => "Motor",
            Self::Calibration => "Calibration",
            Self::Gravity => "重力辨识",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Status => "page-status",
            Self::Dashboard => "page-dashboard",
            Self::Motion => "page-motion",
            Self::Monitor => "page-monitor",
            Self::Collection => "page-collection",
            Self::Handeye => "page-handeye",
            Self::Motor => "page-motor",
            Self::Calibration => "page-calibration",
            Self::Gravity => "page-gravity",
        }
    }
    pub fn from_label(label: &str) -> Option<Self> {
        [
            Self::Status,
            Self::Dashboard,
            Self::Motion,
            Self::Monitor,
            Self::Collection,
            Self::Handeye,
            Self::Motor,
            Self::Calibration,
            Self::Gravity,
        ]
        .into_iter()
        .find(|p| p.label() == label)
    }
}

/// Incarnation is separate from connection epoch: a reopened WebView must not
/// accept callbacks, release subscriptions or acknowledge messages for its predecessor.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct WindowToken {
    pub label: String,
    pub incarnation: u64,
}

#[derive(Default)]
pub struct WindowRegistry {
    sequence: u64,
    windows: BTreeMap<String, WindowToken>,
}

impl WindowRegistry {
    pub fn register(&mut self, actual_native_label: &str) -> Result<WindowToken, &'static str> {
        if actual_native_label != "main" && Page::from_label(actual_native_label).is_none() {
            return Err("未授权的功能窗口");
        }
        if self.windows.contains_key(actual_native_label) {
            return Err("窗口已注册");
        }
        self.sequence = self.sequence.checked_add(1).ok_or("窗口代次耗尽")?;
        let token = WindowToken {
            label: actual_native_label.into(),
            incarnation: self.sequence,
        };
        self.windows
            .insert(actual_native_label.into(), token.clone());
        Ok(token)
    }
    pub fn validate(
        &self,
        actual_native_label: &str,
        token: &WindowToken,
    ) -> Result<(), &'static str> {
        if actual_native_label != token.label
            || self.windows.get(actual_native_label) != Some(token)
        {
            return Err("窗口身份已失效");
        }
        Ok(())
    }
    pub fn remove(&mut self, token: &WindowToken) -> bool {
        if self.windows.get(&token.label) != Some(token) {
            return false;
        }
        self.windows.remove(&token.label);
        true
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub(crate) fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width > 0.0
            && self.height > 0.0
    }
}

/// Coordinates are all logical pixels. Prefer the saved monitor while it exists;
/// otherwise clamp to the current primary work area, including negative origins.
pub fn restore_bounds(saved: Rect, work_area: Rect, minimum: (f64, f64)) -> Option<Rect> {
    if !work_area.valid() {
        return None;
    }
    let saved = if saved.valid() { saved } else { work_area };
    let min_width = if minimum.0.is_finite() {
        minimum.0.max(1.0)
    } else {
        1.0
    };
    let min_height = if minimum.1.is_finite() {
        minimum.1.max(1.0)
    } else {
        1.0
    };
    let width = saved.width.max(min_width).min(work_area.width);
    let height = saved.height.max(min_height).min(work_area.height);
    Some(Rect {
        x: saved
            .x
            .clamp(work_area.x, work_area.x + work_area.width - width),
        y: saved
            .y
            .clamp(work_area.y, work_area.y + work_area.height - height),
        width,
        height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn callers_cannot_impersonate_other_windows_or_reuse_closed_incarnations() {
        let mut windows = WindowRegistry::default();
        assert!(windows.register("page-arbitrary").is_err());
        let old = windows.register("page-motion").unwrap();
        assert!(windows.register("page-motion").is_err());
        assert!(windows.validate("main", &old).is_err());
        assert!(windows.remove(&old));
        let new = windows.register("page-motion").unwrap();
        assert!(windows.validate("page-motion", &old).is_err());
        assert!(!windows.remove(&old));
        assert!(windows.validate("page-motion", &new).is_ok());
    }
    #[test]
    fn unplugged_monitor_bounds_are_clamped_to_available_screen() {
        let area = Rect {
            x: -1920.0,
            y: 24.0,
            width: 1920.0,
            height: 1056.0,
        };
        let saved = Rect {
            x: 3840.0,
            y: 2000.0,
            width: 1440.0,
            height: 900.0,
        };
        assert_eq!(
            restore_bounds(saved, area, (900.0, 620.0)),
            Some(Rect {
                x: -1440.0,
                y: 180.0,
                width: 1440.0,
                height: 900.0
            })
        );
        let small = Rect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        assert_eq!(restore_bounds(saved, small, (900.0, 620.0)), Some(small));
        assert_eq!(
            restore_bounds(
                Rect {
                    x: f64::NAN,
                    ..saved
                },
                small,
                (900.0, 620.0)
            ),
            Some(small)
        );
        assert_eq!(
            restore_bounds(
                saved,
                Rect {
                    width: 0.0,
                    ..small
                },
                (900.0, 620.0)
            ),
            None
        );
    }
}
