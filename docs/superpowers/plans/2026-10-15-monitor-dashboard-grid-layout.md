# Monitor Dashboard Grid Layout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grafana-like Monitor: Dashboard → Panel → Chart with `react-grid-layout`, v1 localStorage migration, Motor Torque = 7 panels.

**Architecture:** Rename domain in `monitorLogic.ts`; `MonitorPage` renders `react-grid-layout` of compact `DataGraph`s; hydrate migrates old `panels[].series[]` tabs to dashboards/panels; App/Inspector target dashboards and append panels.

**Tech Stack:** React 19, TypeScript, vitest, react-grid-layout (pin compatible version), existing DataGraph.

---

## File map

| File | Change |
|------|--------|
| `package.json` / lock | Add `react-grid-layout` (+ `@types/react-grid-layout` if needed) |
| `src/monitorLogic.ts` | Dashboard/Panel types, layout helpers, migrate, CRUD |
| `src/monitorLogic.test.ts` | TDD for layout, migrate, CRUD, fan-out |
| `src/MonitorPage.tsx` | Dashboard tabs + RGL grid of panels |
| `src/MonitorPage.test.tsx` | Update selectors / expectations |
| `src/App.tsx` | Wire dashboard APIs; Inspector add → panels |
| `src/TopicInspector.tsx` | Props: dashboards list (labels); keep API minimal |
| `src/styles.css` | Panel tiles; remove torque-only fixed CSS grid |
| `docs/basic-features.md` / `docs/features.md` | Dashboard/Panel/Chart + drag/resize |
| `docs/superpowers/specs/2026-10-15-monitor-dashboard-panel-layout-design.md` | Spec (already written) |

---

### Task 1: Dependency

- [ ] `npm install react-grid-layout@1.5.2` and `@types/react-grid-layout` (or newer 2.x if clean with React 19)
- [ ] Import `react-grid-layout/css/styles.css` and `react-resizable/css/styles.css` from MonitorPage (or styles entry)
- [ ] Note pinned version in PR if peer warnings

### Task 2: Domain + tests (TDD)

- [ ] Red: tests for `createTorqueDashboard` → 7 panels with expected `{x,y,w,h}`
- [ ] Red: `hydrateMonitorWorkspace` migrates v1 `{ panels, selectedPanelId }` → dashboards/panels
- [ ] Red: `updateDashboardLayout`, `addPanelsToDashboard`, delete last dashboard restores torque
- [ ] Green: implement types + helpers in `monitorLogic.ts`; keep `MONITOR_STORAGE_KEY`
- [ ] Green: `updateMonitorFromMessage` walks `dashboard.panels[].series`
- [ ] Remove `isTorqueEffortGridPanel` special-case (layout system covers all)

### Task 3: MonitorPage UI

- [ ] Dashboard tablist; rename/delete dashboard; + / +转矩
- [ ] `WidthProvider(ReactGridLayout)` with `cols={12}`, `rowHeight`, `onLayoutChange`
- [ ] Each panel: chrome + `DataGraph` compact one-series
- [ ] Empty dashboard hint
- [ ] Update component tests (grid aria label, effort[0]/effort[6] charts, no “7 路 effort 独立图” CSS-grid-only copy)

### Task 4: App + Inspector

- [ ] Rename workspace field usage to `dashboards` / `selectedDashboardId`
- [ ] `addToMonitor(fieldPath, dashboardId)` → append panel(s) via `addFieldsToSeries` expansion
- [ ] TopicInspector: accept `{ id, name }[]` dashboards; Chinese empty copy “暂无仪表盘” / keep 面板 if less churn — prefer 仪表盘 for Dashboard list
- [ ] Fix App.test Monitor assertions if broken

### Task 5: Docs + CSS

- [ ] `basic-features.md` / `features.md`: Dashboard/Panel/Chart, drag/resize, migration
- [ ] Replace `.monitor-chart-grid*` torque CSS with `.monitor-grid` / `.monitor-panel-tile`

### Task 6: Verify + PR

- [ ] `PATH=/tmp/node-v22.20.0-linux-x64/bin:$PATH npm run test:frontend`
- [ ] Commit(s); push; `gh pr create` with summary + test plan
- [ ] Ignore untracked `src-tauri/gen/schemas/linux-schema.json`

---

## Migration caveats (for PR)

- v1 multi-series tab → multiple panels (may look “spread out” vs old overlay chart).
- v1 torque CSS grid positions are not preserved; default 12-col packing applied.
- Saving after load rewrites storage to v2 (irreversible without backup).
