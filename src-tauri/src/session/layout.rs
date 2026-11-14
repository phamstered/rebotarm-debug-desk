//! Bounded, versioned window preferences. Never persists connection credentials,
//! task ownership, motion authorization or page contents.
use super::windows::{restore_bounds, Page, Rect};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex};

const MAX_BYTES: u64 = 32 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Geometry {
    pub outer: Rect,
    pub decoration: (f64, f64),
    pub monitor: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Display {
    pub name: Option<String>,
    pub area: Rect,
}

impl Geometry {
    fn valid(&self) -> bool {
        self.outer.valid()
            && self.outer.width <= 100_000.0
            && self.outer.height <= 100_000.0
            && self.outer.x.abs() <= 1_000_000.0
            && self.outer.y.abs() <= 1_000_000.0
            && [self.decoration.0, self.decoration.1]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.0)
            && self.decoration.0 < self.outer.width
            && self.decoration.1 < self.outer.height
            && self.monitor.as_ref().is_none_or(|name| name.len() <= 512)
    }

    pub fn inner_size(&self) -> (f64, f64) {
        (
            self.outer.width - self.decoration.0,
            self.outer.height - self.decoration.1,
        )
    }

    pub fn restore(&self, displays: &[Display], minimum: (f64, f64)) -> Option<Self> {
        if !self.valid() {
            return None;
        }
        // Duplicate display names are common. Prefer the one with the largest
        // overlap; if the saved display is absent, prefer any overlapping display
        // and finally the primary work area (first in the list).
        let mut best: Option<(&Display, (bool, f64))> = None;
        for display in displays.iter().filter(|display| display.area.valid()) {
            let intersection = overlap(self.outer, display.area);
            let score = (
                self.monitor.is_some() && self.monitor == display.name,
                intersection,
            );
            if best.as_ref().is_none_or(|(_, previous)| score > *previous) {
                best = Some((display, score));
            }
        }
        let display = best?.0;
        let outer = restore_bounds(
            self.outer,
            display.area,
            (minimum.0 + self.decoration.0, minimum.1 + self.decoration.1),
        )?;
        if outer.width <= self.decoration.0 || outer.height <= self.decoration.1 {
            return None;
        }
        Some(Self {
            outer,
            decoration: self.decoration,
            monitor: display.name.clone(),
        })
    }
}

fn overlap(a: Rect, b: Rect) -> f64 {
    ((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0.0)
        * ((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0.0)
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PageLayout {
    pub detached: bool,
    pub geometry: Option<Geometry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    version: u32,
    pub selected: Page,
    pub main: Option<Geometry>,
    pub pages: BTreeMap<Page, PageLayout>,
}

impl Default for Layout {
    fn default() -> Self {
        Self {
            version: 1,
            selected: Page::Status,
            main: None,
            pages: BTreeMap::new(),
        }
    }
}

impl Layout {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() as u64 > MAX_BYTES {
            return Err("窗口布局文件过大".into());
        }
        let layout: Self =
            serde_json::from_slice(bytes).map_err(|e| format!("窗口布局格式无效：{e}"))?;
        if layout.version != 1
            || layout
                .main
                .as_ref()
                .is_some_and(|geometry| !geometry.valid())
            || layout.pages.values().any(|page| {
                page.geometry
                    .as_ref()
                    .is_some_and(|geometry| !geometry.valid())
            })
        {
            return Err("窗口布局版本或坐标无效".into());
        }
        Ok(layout)
    }
}

#[derive(Default)]
struct Stored {
    path: Option<PathBuf>,
    layout: Layout,
    dirty: bool,
}

#[derive(Default)]
pub struct LayoutStore(Mutex<Stored>);

impl LayoutStore {
    pub fn load(&self, path: PathBuf) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        state.path = Some(path.clone());
        match fs::metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("读取窗口布局失败：{e}")),
            Ok(metadata) => {
                if metadata.len() > MAX_BYTES {
                    return Err("窗口布局文件过大".into());
                }
                let bytes = fs::read(path).map_err(|e| format!("读取窗口布局失败：{e}"))?;
                state.layout = Layout::decode(&bytes)?;
                Ok(())
            }
        }
    }

    pub fn snapshot(&self) -> Layout {
        self.0.lock().unwrap().layout.clone()
    }

    pub fn update(&self, change: impl FnOnce(&mut Layout)) {
        let mut state = self.0.lock().unwrap();
        let before = state.layout.clone();
        change(&mut state.layout);
        state.dirty |= state.layout != before;
    }

    /// Called on the background maintenance tick and app exit. Keeping the lock
    /// through rename prevents an older write from replacing a later layout.
    pub fn flush(&self) -> Result<(), String> {
        let mut state = self.0.lock().unwrap();
        if !state.dirty {
            return Ok(());
        }
        let Some(path) = state.path.as_ref() else {
            return Ok(());
        };
        let bytes = serde_json::to_vec_pretty(&state.layout).map_err(|e| e.to_string())?;
        Layout::decode(&bytes)?;
        let parent = path.parent().ok_or("窗口布局目录无效")?;
        fs::create_dir_all(parent).map_err(|e| format!("创建窗口布局目录失败：{e}"))?;
        let temp = path.with_extension(format!("{}.tmp", std::process::id()));
        let write = (|| {
            let mut file = fs::File::create(&temp)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            fs::rename(&temp, path)
        })();
        if let Err(e) = write {
            let _ = fs::remove_file(temp);
            return Err(format!("保存窗口布局失败：{e}"));
        }
        state.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn geometry() -> Geometry {
        Geometry {
            outer: Rect {
                x: 2200.,
                y: 100.,
                width: 1200.,
                height: 832.,
            },
            decoration: (0., 32.),
            monitor: Some("external".into()),
        }
    }
    fn displays() -> Vec<Display> {
        vec![
            Display {
                name: Some("primary".into()),
                area: Rect {
                    x: 0.,
                    y: 24.,
                    width: 1440.,
                    height: 850.,
                },
            },
            Display {
                name: Some("external".into()),
                area: Rect {
                    x: 1440.,
                    y: 0.,
                    width: 1920.,
                    height: 1080.,
                },
            },
        ]
    }
    #[test]
    fn restores_saved_display_and_recovers_titlebar_after_unplug_or_resolution_change() {
        let original = geometry();
        let restored = original.restore(&displays(), (640., 480.)).unwrap();
        assert_eq!(restored.outer.x, 2160.);
        assert_eq!(restored.inner_size(), (1200., 800.));
        let recovered = original.restore(&displays()[..1], (640., 480.)).unwrap();
        assert_eq!(recovered.outer.x, 240.);
        assert_eq!(recovered.outer.y, 42.);
        assert_eq!(recovered.monitor.as_deref(), Some("primary"));
        let small = vec![Display {
            name: None,
            area: Rect {
                x: -500.,
                y: 24.,
                width: 500.,
                height: 400.,
            },
        }];
        let recovered = original.restore(&small, (640., 480.)).unwrap();
        assert_eq!(recovered.outer, small[0].area);
        assert_eq!(recovered.inner_size(), (500., 368.));
    }
    #[test]
    fn duplicate_names_choose_overlap_missing_names_use_primary_and_invalid_screens_are_ignored() {
        let mut areas = displays();
        areas[0].name = Some("external".into());
        assert_eq!(
            geometry().restore(&areas, (640., 480.)).unwrap().outer.x,
            2160.
        );
        let mut g = geometry();
        g.monitor = None;
        g.outer.x = -5000.;
        assert_eq!(g.restore(&areas, (640., 480.)).unwrap().outer.x, 0.);
        areas[0].area.width = f64::NAN;
        assert_eq!(g.restore(&areas, (640., 480.)).unwrap().outer.x, 1440.);
        assert!(g.restore(&[], (640., 480.)).is_none());
    }
    #[test]
    fn layout_file_roundtrips_only_preferences_and_rejects_untrusted_or_future_state() {
        let mut value = serde_json::to_value(Layout::default()).unwrap();
        for (key, item) in [
            ("authorized", serde_json::json!(true)),
            ("version", serde_json::json!(2)),
            ("selected", serde_json::json!("unknown")),
            (
                "pages",
                serde_json::json!({"invalid": {"detached":true,"geometry":null}}),
            ),
        ] {
            let mut invalid = value.clone();
            invalid[key] = item;
            assert!(Layout::decode(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        value["main"] = serde_json::to_value(geometry()).unwrap();
        value["main"]["decoration"] = serde_json::json!([0, 900]);
        assert!(Layout::decode(&serde_json::to_vec(&value).unwrap()).is_err());
        assert!(Layout::decode(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
        let path = std::env::temp_dir().join(format!(
            "workspace-layout-{}-{:?}/layout.json",
            std::process::id(),
            std::thread::current().id()
        ));
        let store = LayoutStore::default();
        store.load(path.clone()).unwrap();
        store.update(|state| {
            state.selected = Page::Handeye;
            state.pages.insert(
                Page::Handeye,
                PageLayout {
                    detached: true,
                    geometry: Some(geometry()),
                },
            );
        });
        store.flush().unwrap();
        let reopened = LayoutStore::default();
        reopened.load(path.clone()).unwrap();
        assert_eq!(store.snapshot(), reopened.snapshot());
        assert!(!reopened.0.lock().unwrap().dirty);
        store.update(|state| state.selected = Page::Handeye);
        assert!(!store.0.lock().unwrap().dirty);
        fs::write(&path, b"partial corrupt file").unwrap();
        let corrupt = LayoutStore::default();
        assert!(corrupt.load(path.clone()).is_err());
        assert_eq!(corrupt.snapshot(), Layout::default());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
