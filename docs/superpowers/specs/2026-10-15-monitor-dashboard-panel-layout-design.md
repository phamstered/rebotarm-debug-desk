# Monitor Dashboard / Panel Layout Design

Date: 2026-10-15  
Repo: `phamstered/rebotarm-debug-desk`  
Status: approved for implementation (approve-spec-and-build)  
Owner: rebotarm-debug-desk (上位机)

## 1. Goal

Evolve the Monitor page from a **tab-of-charts** model into a **Grafana-like** hierarchy:

**Dashboard → Panel → Chart**

so users can arrange multiple time-series charts on a single dashboard with **drag and resize**, while keeping today’s live Bridge sampling, Jetson bag play, Inspector “add to Monitor”, and localStorage persistence.

Default **Motor Torque** becomes **one Dashboard with seven Panels** (`effort[0..6]`), each Panel hosting one `DataGraph` chart — not one Panel containing seven charts.

## 2. Non-goals

- Embedding Grafana, Grafana Agent, or Prometheus.
- Multi-chart panels (one Panel = one Chart in v1+).
- Cross-dashboard variables, annotations, alerting, or datasource plugins.
- ROS / FreeRTOS / Bridge protocol changes.
- Weakening motor / control safety gates.
- Per-user cloud sync of layouts (localStorage only).

## 3. Current baseline (as of 2026-10-15)

Already shipped (#56, #58, #71):

- Monitor nav page; workspace in `localStorage` key `robot-console-monitor`.
- Top tabs called “panels”; each tab holds `series[]` and either one multi-series `DataGraph` or a **fixed CSS grid** of seven effort charts when the torque template is detected.
- Inspector context menu lists those tabs; adding fields merges into the selected tab’s `series[]` (single-topic replace semantics via `addFieldsToSeries`).
- Live updates + Jetson `ros2 bag play` path validation unchanged.

Gaps vs Grafana-like UX:

- Vocabulary conflates Dashboard (tab) with Panel (tile).
- Layout is not user-editable (CSS grid / single chart only).
- Multi-series tabs do not map cleanly to “one chart per panel”.
- Persistence schema has no layout fields and no version for migration.

## 4. Product principles

1. **Grafana vocabulary, ROS data** — Dashboard / Panel / Chart in UI and types; data still comes from Bridge topics and field paths.
2. **One Chart per Panel** — Panel is a draggable/resizable tile; Chart is `DataGraph` (compact mode OK).
3. **Same layout system for all Monitor charts** — Torque is not a special renderer; it is seven panels on a default layout.
4. **Layouts survive reload** — persist grid positions; migrate old shapes without wiping user dashboards.
5. **Desk lane only** — Tauri/React host; no Bridge/ROS changes.

## 5. Recommended approach

**Domain rename + `react-grid-layout` + schema v2 migrate-on-hydrate.**

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| A. `react-grid-layout` on Dashboard | Proven drag/resize, 12-col grid, CSS included | Extra dependency; React 19 peer soft | **Choose** |
| B. Custom pointer + CSS grid | No dep | Rebuild resize/collision | Reject for v1+ |
| C. Embed Grafana iframe | Familiar | Wrong stack, auth, ROS WS | Reject |

Pin a compatible `react-grid-layout` release if peer/React 19 warnings appear; note the pin in the PR.

## 6. Information architecture

```
Monitor page
├── Header (title, live / bag source toggle)
├── Dashboard tabs (was: panel tabs)
│   ├── + empty Dashboard
│   └── +转矩 → Motor Torque Dashboard template
├── Dashboard meta (rename / delete Dashboard)
├── Bag controls (unchanged role)
└── Grid (react-grid-layout)
    └── Panel tiles
        └── Chart = DataGraph (one series each)
```

**Concept map**

| Old | New |
|-----|-----|
| `MonitorWorkspace.panels[]` (tabs) | `dashboards[]` |
| `selectedPanelId` | `selectedDashboardId` |
| Tab `series[]` rendered as one chart or torque CSS grid | `panels[]` each with `layout` + one series → one Chart |
| Inspector targets a “panel” tab | Inspector targets a **Dashboard**; add creates new **Panel(s)** |

## 7. Domain model

```ts
type GridLayoutItem = {
  i: string; // === panel.id
  x: number;
  y: number;
  w: number;
  h: number;
};

type MonitorPanel = {
  id: string;
  title: string;       // e.g. "effort[0]"
  layout: GridLayoutItem;
  series: DataSeries;  // exactly one series for the Chart
};

type MonitorDashboard = {
  id: string;
  name: string;        // e.g. "Motor Torque"
  panels: MonitorPanel[];
};

type MonitorWorkspace = {
  dashboards: MonitorDashboard[];
  selectedDashboardId: string;
};
```

Runtime `DataSeries.points` stay in memory only; persistence stores topic / fieldPath / color + layout.

**Default Motor Torque Dashboard (12-col)**

Seven panels, `h = 2`, `w = 4`:

| Panel | x | y |
|-------|---|---|
| effort[0] | 0 | 0 |
| effort[1] | 4 | 0 |
| effort[2] | 8 | 0 |
| effort[3] | 0 | 2 |
| effort[4] | 4 | 2 |
| effort[5] | 8 | 2 |
| effort[6] | 0 | 4 |

Row height ~ compact chart (~80–100px CSS). Users can drag/resize afterward.

**Empty Dashboard** — `panels: []`; show empty hint (Inspector add or +转矩).

## 8. Layout & UX

- Library: **react-grid-layout** (`WidthProvider` or measured width); import its CSS.
- `cols = 12`, `draggableHandle` optional (panel chrome title bar preferred so chart drag does not fight).
- `onLayoutChange` → update each panel’s `layout` and persist via existing save effect.
- Min size: e.g. `minW = 3`, `minH = 2` so charts remain readable.
- Panel chrome: title (field path or custom), remove-panel control; Chart uses compact `DataGraph`.
- Removing the Chart’s series removes the Panel (one series ⇒ nothing left to show).
- Dashboard CRUD mirrors today’s tab CRUD (Chinese strings stay consistent; labels may say Dashboard / 仪表盘 and Panel / 面板).
- “清空” on a Dashboard removes all panels (or clears series by deleting panels).

**Inspector**

- Context menu lists **Dashboards** (id + name).
- Choosing a Dashboard expands the field into one or more series (`addFieldsToSeries` semantics) and **appends one Panel per series** with auto-placed layout (next free row), then navigates to Monitor with that Dashboard selected.
- Single-topic replace rule from multi-series tabs is **dropped** at Panel level (each Panel is already one series); adding from another topic simply adds more Panels.

## 9. Persistence & migration

- Storage key remains **`robot-console-monitor`** (avoid orphaning prefs).
- Persisted shape v2:

```json
{
  "version": 2,
  "selectedDashboardId": "…",
  "dashboards": [
    {
      "id": "…",
      "name": "Motor Torque",
      "panels": [
        {
          "id": "…",
          "title": "effort[0]",
          "layout": { "i": "…", "x": 0, "y": 0, "w": 4, "h": 2 },
          "series": { "topic": "/js", "fieldPath": "effort[0]", "color": "#…" }
        }
      ]
    }
  ]
}
```

**Migrate on hydrate** when `version` missing or shape matches v1:

1. Detect v1: top-level `panels[]` with `series[]` and `selectedPanelId` (no `dashboards`).
2. Each v1 panel → one Dashboard (`id`/`name` preserved).
3. Each v1 series entry → one Panel; layout packed left-to-right, `w=4`, `h=2`, 12-col (same packing helper as torque default).
4. `selectedPanelId` → `selectedDashboardId`.
5. Corrupt / empty → `createDefaultMonitorWorkspace` (Motor Torque × 7 panels).
6. After successful migrate, next save writes v2 (upgrade in place).

Do not keep dual writers; only hydrate understands v1.

## 10. Architecture

```
monitorLogic.ts
  types Dashboard/Panel, default torque layout,
  persist/hydrate/migrate, CRUD, layout update,
  updateMonitorFromMessage (fan-out to every panel series),
  addPanelsFromFields helper for Inspector

MonitorPage.tsx
  dashboard tabs + meta + bag UI
  ReactGridLayout of panels → DataGraph compact

App.tsx
  workspace state; Inspector passes dashboards;
  addToMonitor appends panels

styles.css
  panel tile + grid container; retire torque-only CSS grid rules

docs/basic-features.md, docs/features.md
  Dashboard / Panel / Chart + drag/resize + migration note
```

Testing:

- Unit: default layout, v1→v2 migrate, CRUD, layout patch, message fan-out, bag path (unchanged).
- Component: dashboard tabs, grid panels for torque, rename/delete, bag validation.
- `npm run test:frontend` with Node 22 on PATH if system Node is old.

## 11. Out of scope (follow-ups)

- Responsive breakpoints (`react-grid-layout` Responsive layouts).
- Panel title editing beyond auto field-path titles.
- Multi-series overlay Chart inside one Panel.
- Export/import dashboard JSON files.
- Shared Y-axis / synced crosshair across panels.

## 12. Success criteria

- Motor Torque opens as one Dashboard with seven independently draggable/resizable Panels.
- Drag/resize persists across reload via localStorage v2.
- Existing v1 localStorage loads without data loss (series become panels).
- Inspector can add fields as new Panels onto a chosen Dashboard.
- Live + bag playback still feed charts; safety/bag path checks unchanged.
- Frontend tests green; docs describe Dashboard / Panel / Chart.

## 13. Approval

Product choice **approve-spec-and-build** — implement on the same branch after this spec and a short plan land.
