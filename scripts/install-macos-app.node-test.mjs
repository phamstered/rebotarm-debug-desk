import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installMacApp } from "./install-macos-app.mjs";

test("installs a release bundle and replaces an existing app", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "robot-console-install-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const applications = join(root, "Applications");
  const source = join(root, "Robot Console.app");
  const installed = join(applications, "Robot Console.app");
  await mkdir(source);
  await mkdir(installed, { recursive: true });
  await writeFile(join(source, "version"), "new");
  await writeFile(join(installed, "version"), "old");

  assert.equal(await installMacApp(source, applications), installed);
  assert.equal(await readFile(join(installed, "version"), "utf8"), "new");
});

test("missing release bundle leaves the installed app untouched", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "robot-console-install-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const applications = join(root, "Applications");
  const installed = join(applications, "Robot Console.app");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "version"), "old");

  await assert.rejects(
    installMacApp(join(root, "Robot Console.app"), applications),
    { code: "ENOENT" },
  );
  assert.equal(await readFile(join(installed, "version"), "utf8"), "old");
});
