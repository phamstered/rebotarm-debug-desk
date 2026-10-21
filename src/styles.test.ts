import { afterEach, describe, expect, it, vi } from "vitest";

describe("connected page layout styles", () => {
  afterEach(() => {
    document.head.querySelector("style[data-layout-test]")?.remove();
    document.body.innerHTML = "";
  });

  it("keeps the connected toolbar in its own grid row while preserving the Topics toolbar area", async () => {
    const { readFileSync } = await vi.importActual<{ readFileSync: (path: string, encoding: string) => string }>("node:fs");
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain(".workspace > .app-toolbar");
    const style = document.createElement("style");
    style.dataset.layoutTest = "";
    style.textContent = styles;
    document.head.appendChild(style);
    document.body.innerHTML = `
      <div class="app-main-column">
        <header class="connected-topbar"></header>
        <div class="app-page-content">
          <main class="status-page"><header class="status-page-header"></header></main>
        </div>
      </div>
      <main class="workspace"><header class="app-toolbar"></header></main>
    `;

    const connectedToolbar = document.querySelector(".connected-topbar")!;
    const statusHeader = document.querySelector(".status-page-header")!;
    const topicsToolbar = document.querySelector(".app-toolbar")!;

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
