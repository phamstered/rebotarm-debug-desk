import { afterEach, describe, expect, it, vi } from "vitest";

describe("connected page layout styles", () => {
  afterEach(() => {
    document.head.querySelector("style[data-layout-test]")?.remove();
    document.body.innerHTML = "";
  });

  it("shares the header row between Navigation and the wrapping connected toolbar", async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync: (path: string, encoding: string) => string }>("node:fs");
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain(".workspace > .app-toolbar");
    const style = document.createElement("style");
    style.dataset.layoutTest = "";
    style.textContent = styles;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="app-shell">
        <nav class="app-nav">
          <div class="app-nav-brand">Navigation</div>
          <div class="app-nav-body"></div>
        </nav>
        <div class="app-main-column">
          <header class="connected-topbar"></header>
          <div class="app-page-content">
            <main class="status-page"><header class="status-page-header"></header></main>
          </div>
        </div>
      </div>
      <main class="workspace"><header class="app-toolbar"></header></main>
    `;

    const connectedToolbar = document.querySelector(".connected-topbar")!;
    const statusHeader = document.querySelector(".status-page-header")!;
    const topicsToolbar = document.querySelector(".app-toolbar")!;

    expect(getComputedStyle(document.querySelector(".app-shell")!).gridTemplateRows).toBe("auto minmax(0, 1fr)");
    for (const selector of [".app-nav", ".app-main-column"]) {
      const column = getComputedStyle(document.querySelector(selector)!);
      expect(column.gridRow).toBe("1 / -1");
      expect(column.gridTemplateRows).toBe("subgrid");
    }
    expect(getComputedStyle(document.querySelector(".app-nav-brand")!).minHeight).toBe("54px");
    expect(getComputedStyle(document.querySelector(".app-nav-body")!).overflow).toBe("auto");
    expect(getComputedStyle(connectedToolbar).gridArea).toBe("");
    expect(getComputedStyle(statusHeader).gridArea).toBe("");
    expect(getComputedStyle(topicsToolbar).gridArea).toBe("header");
    expect(getComputedStyle(connectedToolbar).flexWrap).toBe("wrap");
  });

  it("uses the whole chart width for compact Panels without changing the full DataGraph legend", async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync: (path: string, encoding: string) => string }>("node:fs");
    const style = document.createElement("style");
    style.dataset.layoutTest = "";
    style.textContent = readFileSync("src/styles.css", "utf8");
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="data-graph-view compact"><div class="data-graph-body"></div></div>
      <div class="data-graph-view"><div class="data-graph-body"></div></div>
    `;

    const compactBody = document.querySelector(".data-graph-view.compact .data-graph-body")!;
    const fullBody = document.querySelector(".data-graph-view:not(.compact) .data-graph-body")!;
    expect(getComputedStyle(compactBody).gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(getComputedStyle(compactBody).height).toBe("auto");
    expect(getComputedStyle(fullBody).gridTemplateColumns).toBe("minmax(0, 1fr) 168px");
  });

  it("uses height 100% for Motor/Monitor/Calibration under connected-topbar (not 100vh)", async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync: (path: string, encoding: string) => string }>("node:fs");
    const styles = readFileSync("src/styles.css", "utf8");
    for (const sel of [".motor-page", ".monitor-page", ".calibration-page"]) {
      expect(styles).toContain(`${sel} { height: 100%;`);
      expect(styles).not.toContain(`${sel} { height: 100vh;`);
    }
  });
});
