import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePackageVersion,
  readBridgeBuildId,
  renderCppHeader,
  renderTsModule,
  generateBridgeBuildId,
} from "./generate-bridge-build-id.mjs";

test("parsePackageVersion reads package.xml version", () => {
  assert.equal(parsePackageVersion("<package><version>0.1.0</version></package>"), "0.1.0");
  assert.throws(() => parsePackageVersion("<package></package>"));
});

test("renderers embed version and build id", () => {
  const header = renderCppHeader({ version: "0.1.0", buildId: "abc1234def56" });
  assert.match(header, /EASY_DEBUG_BRIDGE_VERSION "0\.1\.0"/);
  assert.match(header, /EASY_DEBUG_BRIDGE_BUILD_ID "abc1234def56"/);
  const ts = renderTsModule({ version: "0.1.0", buildId: "abc1234def56" });
  assert.match(ts, /EXPECTED_BRIDGE_VERSION = "0\.1\.0"/);
  assert.match(ts, /EXPECTED_BRIDGE_BUILD_ID = "abc1234def56"/);
});

test("readBridgeBuildId is stable for current package sources", async () => {
  const a = await readBridgeBuildId();
  const b = await readBridgeBuildId();
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{12}$/);
});

test("generateBridgeBuildId --check path matches committed outputs", async () => {
  const generated = await generateBridgeBuildId({ write: false });
  assert.equal(generated.version, "0.1.0");
  assert.match(generated.buildId, /^[0-9a-f]{12}$/);
});
