# Topic Graph Browser UX Design

Date: 2026-10-15  
Repo: `phamstered/robot-debug-desk`  
Status: draft — awaiting review  
Owner: robot-debug-desk (上位机)

## 1. Goal

Give Robot Debug Desk a **Neo4j Browser–like exploration feel** for the ROS Topic Graph, without copying Neo4j’s product model (no Cypher, no graph DB, no Neo4j server).

Users should be able to **pan/zoom a dark canvas, drag and pin nodes, search and focus, expand neighborhoods, and read edge activity**, while keeping today’s ROS-specific behaviors: Node vs Topic shapes, publish/subscribe direction, Controller focus, Bridge filter, and Inspector / subscribe integration.

## 2. Non-goals

- Embedding Neo4j Browser, Neo4j Desktop, or Bloom.
- Cypher or arbitrary graph query language in v1–v3.
- Replacing Inspector / Monitor / Motor flows.
- Changing Bridge `graph` topology semantics (ids, kinds, relations) except optional **rate enrichment** in phase 2+.
- Weakening motor / control safety gates.

## 3. Current baseline (as of 2026-10-15)

Already shipped:

- Deterministic force layout; Node = rounded rect, Topic = ellipse; size by degree.
- 30s / manual graph refresh; Bridge hide toggle; Controller one-hop focus.
- Click → focus + Inspector / subscribe.
- Draggable nodes with positions kept across refresh while ids remain (#67).
- Placeholder particle flow on edges (publish faster than subscribe); **real Hz not wired yet**.

Gaps vs Neo4j Browser–style UX:

- No camera transform (zoom / pan); scrollport only.
- No pin, multi-select, box select, fit/reset camera.
- No search box on the graph toolbar.
- No expand/collapse neighborhood beyond single-click highlight.
- No legend / type filters beyond Bridge.
- Edge motion not driven by measured rates.

## 4. Product principles (fit this tool)

1. **ROS-native, not DB-native** — vocabulary stays Node / Topic / publish / subscribe / Controller.
2. **Exploration first, typing second** — mouse/trackpad primary; optional light filter string later.
3. **Inspector remains the property panel** — do not duplicate a second Neo4j-style property drawer.
4. **Live graph may refresh** — manual layout (drag/pin) must survive refresh; auto layout must not yank pinned nodes.
5. **Performance** — typical graphs tens–low hundreds of nodes; keep SVG custom renderer until proven insufficient (~500+ nodes).

## 5. Recommended approach

**Custom SVG canvas + camera transform + existing force layout**, evolved in place (`TopicGraph.tsx` / `topicGraphLogic.ts`).

Alternatives considered:

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| A. Evolve current SVG | Keeps tests, styling, ROS semantics; small diffs | Must implement pan/zoom/select ourselves | **Choose** |
| B. `react-force-graph-2d` / Cytoscape | Rich interactions out of the box | Style mismatch, harder ROS edge particles, bigger dependency | Defer unless SVG hits a wall |
| C. Embed Neo4j Browser | Familiar UI | Wrong data model, heavy stack, private ROS graph over WS | Reject |

## 6. Information architecture

```
Topics page
├── Left: topic / controller lists (unchanged)
├── Center tabs: Robot View | Topic Graph
│   └── Graph chrome
│       ├── Search / filter
│       ├── View tools (fit, reset layout, zoom %, pin/unpin)
│       ├── Toggles (Bridge, legend filters)
│       └── Canvas (camera + nodes + edges + particles)
└── Right: Inspector (unchanged role as detail panel)
```

Selection model:

- **Primary selection** → drives Inspector / subscribe (today’s focused node/topic).
- **Multi-selection** (phase 1) → visual only + bulk pin/hide; Inspector still follows primary.
- **Controller focus** → remains a highlight mode; clears on manual canvas focus unless re-triggered.

## 7. Interaction design by phase

### Phase 1 — Canvas (Neo4j-like viewport)

**Must have**

- **Zoom**: trackpad/wheel over canvas; buttons `+` / `−`; clamp e.g. 0.25×–3×.
- **Pan**: drag on empty background (middle-click or space+drag optional); distinguish from node drag.
- **Fit**: frame all visible (or selected) nodes with padding.
- **Reset view**: zoom 1 + pan home (does not clear pins unless “Reset layout”).
- **Pin**: pinned nodes ignore force updates; survive refresh; visual pin mark.
- **Search**: toolbar input matches node/topic label substring; Enter focuses + pans to first hit; Cycle next match.
- **Multi-select**: Shift+click toggle; optional marquee on empty drag when not panning (Alt+drag or tool mode — pick one in implementation plan).
- **Keyboard**: `F` fit, `0` reset view, `/` focus search, `Esc` clear selection highlight.

**Nice to have in phase 1**

- Minimap (skip if timeboxed).
- Zoom-to-selection.

**Acceptance**

- Can navigate a dense graph without relying on OS scrollbars alone.
- Dragged/pinned positions remain after graph refresh for surviving ids.
- Search finds `/joint_states` and centers camera.
- Existing click → Inspector / subscribe still works (click vs drag slop preserved).

### Phase 2 — Exploration + real flow

**Must have**

- **Expand neighborhood**: double-click (or context action) isolates/emphasizes 1-hop; optional “expand locked set” that keeps neighborhood when graph refreshes.
- **Hide / only-selected**: hide unselected or dim harder; “show all” restore.
- **Legend filters**: toggle visibility of Node vs Topic; optional namespace prefix chips later.
- **Real edge Hz**:
  - Prefer **Bridge-reported rates** for full-graph edges (protocol extension), so flow shows without subscribing everything.
  - Fallback: desk `TopicSample.hz` for topics already subscribed (partial graph).
  - Particle speed / density mapped from Hz with clamp; 0 Hz → static edge.
- **Stale handling**: if rate missing, keep dim static edge (not fake publish/subscribe tiers).

**Protocol sketch (Bridge, coordinate with stack only for data — UI owned here)**

```json
{
  "op": "graph",
  "request_id": "...",
  "graph": {
    "nodes": [ ... ],
    "edges": [
      {
        "source": "node:/driver",
        "target": "topic:/joint_states",
        "relation": "publish",
        "hz": 48.2
      }
    ]
  }
}
```

`hz` optional for backward compatibility. Measurement window defined in Bridge (e.g. 1–2 s EMA); desk does not invent rates.

**Acceptance**

- Double-click expand clarifies local topology.
- Edges with Bridge `hz` animate proportionally; subscribed-only fallback documented.
- Fake constant tiers removed once real Hz path ships.

### Phase 3 — Power tools

**Must have**

- Layout modes: **Force** (default), **Pinned-only freeze**, optional **Hierarchical** (publish left → topic → subscribe right) for small graphs.
- Light filter grammar (not Cypher), examples:
  - `joint` — substring
  - `kind:topic`
  - `kind:node ns:/arm`
  - `-bridge` — hide bridge-like names (mirror toggle)
- Export: PNG snapshot of canvas; JSON of visible subgraph (nodes/edges).
- Persist UI prefs: camera optional, pin set, legend filters in `localStorage`.

**Nice to have**

- Context menu: copy name, open in Inspector, pin, hide.
- “Seed from Controller” = today’s focus plus expand lock.

**Acceptance**

- Filter string round-trips in tests; invalid tokens show inline hint, don’t crash.
- Export produces file without leaking credentials.

## 8. Visual language

Stay on Robot Debug Desk dark theme (already Neo4j-adjacent: dark canvas, cyan/teal nodes).

Align further without a full redesign:

- Graph chrome as compact tool strip (Neo4j-like top bar density).
- Selected: strong stroke + soft glow (keep).
- Pinned: small badge / filled corner.
- Dimmed: low opacity (keep).
- Particles: short trails optional in phase 2; keep cheap circles first.
- Legend: Node / Topic / publish / subscribe color keys.

Do **not** invent a second side property panel; Inspector is the property view.

## 9. Architecture

```
topicGraphLogic.ts
  layoutRosGraph, filter*, focus*, camera helpers,
  pin merge, search index, filter grammar, hz→particle mapping

TopicGraph.tsx
  chrome + pointer state machine (pan / drag / marquee)
  SVG layer: edges, particles, nodes
  camera: { scale, tx, ty } applied via group transform

App.tsx
  unchanged ownership of subscribe / Inspector selection callbacks

Bridge (phase 2+)
  optional edge.hz on graph response
```

State that must be explicit:

- `camera`
- `manualPositions` / `pinnedIds`
- `selection` (primary + set)
- `visibility filters`
- `expandLock` (optional)
- `edgeRates` (from graph payload and/or messages)

Testing:

- Logic unit tests for camera fit, pin merge across refresh, filter grammar, hz mapping.
- Component tests for search, pan tool discrimination, double-click expand.
- Docs: `docs/basic-features.md` / `docs/features.md` / `docs/protocol.md` when `hz` lands.

## 10. Rollout & PR slicing

| PR | Scope | Depends |
|----|-------|---------|
| P1a | Camera zoom/pan/fit/reset | — |
| P1b | Pin + search + multi-select | P1a |
| P2a | Expand / hide / legend | P1 |
| P2b | Bridge `hz` + particle mapping; remove fake tiers | Bridge change + desk |
| P3 | Filter grammar + export + layout modes | P2 optional |

Each PR: Issue → branch → tests green → squash merge via owner auto-merge workflow.

## 11. Open questions (resolve before P1 code)

1. Marquee select gesture: **Alt+drag** vs dedicated “select tool” toggle?
2. Should Fit frame **all nodes** or **selection-or-all**?
3. Phase 2 Hz: commit to **Bridge edge.hz** as source of truth, with subscribed Hz only as interim?

## 12. Success criteria

A developer debugging RebotArm can open Topic Graph and, without leaving the desk:

- Freely zoom/pan a busy graph like Neo4j Browser.
- Pin important nodes, search a topic, and keep layout under refresh.
- Expand a controller neighborhood and see which edges are actually hot (real Hz).
- Still one-click into Inspector / subscribe / Monitor workflows.

## 13. Approval

Please review this doc and call out changes to phases, Hz source, or selection gestures. After approval, implementation starts at **P1a** unless you reprioritize.
