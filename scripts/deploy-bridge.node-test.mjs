import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RSYNC_EXCLUDES,
  assertLocalPackage,
  buildRemoteBackupScript,
  buildRemoteBuildScript,
  buildRemoteRestartScript,
  buildRemoteVerifyScript,
  buildRsyncArgs,
  buildSshCommandArgs,
  buildRsyncShell,
  isSafeRemotePath,
  parseArgs,
  parseVerifyOutput,
  resolveConfig,
  summarizeRsyncItemize,
  DeployStageError,
  deployBridge,
  DEFAULTS,
  shellQuote,
  remotePathWord,
  projectRoot,
} from "./deploy-bridge.mjs";

test("resolveConfig applies generic defaults and env overrides", () => {
  const config = resolveConfig(
    {},
    {
      BRIDGE_DEPLOY_HOST: "jetson-b",
      BRIDGE_DEPLOY_REMOTE: "/opt/bridge_ws",
      BRIDGE_DEPLOY_ROS_SETUP: "/opt/robot/install/setup.bash",
      BRIDGE_DEPLOY_PORT: "9876",
      BRIDGE_DEPLOY_ROS_DOMAIN_ID: "7",
    },
  );
  assert.equal(config.host, "jetson-b");
  assert.equal(config.remoteRoot, "/opt/bridge_ws");
  assert.equal(config.remotePackage, "/opt/bridge_ws/src/easy_debug_bridge");
  assert.equal(config.rosSetup, "/opt/robot/install/setup.bash");
  assert.equal(config.remotePort, 9876);
  assert.equal(config.rosDomainId, 7);
  assert.match(config.localPackage, /bridge\/easy_debug_bridge$/);
});

test("parseArgs rejects unknown flags and unsafe hosts", () => {
  assert.throws(() => parseArgs(["--nope"]), DeployStageError);
  assert.throws(
    () => resolveConfig({ host: "bad;host" }, {}),
    (error) => error instanceof DeployStageError && error.stage === "config",
  );
  assert.throws(() => resolveConfig({ host: "-oProxyCommand=x" }, {}), DeployStageError);
  for (const remoteRoot of ["../escape", "ws/../../etc", "~/ws", "ws/-x", "/", "a b", "ws;reboot", "$(id)"]) {
    assert.throws(() => resolveConfig({ remoteRoot }, {}), DeployStageError, remoteRoot);
  }
  assert.throws(() => resolveConfig({ rosSetup: "../setup.bash" }, {}), DeployStageError);
});

test("relative defaults resolve against remote $HOME and repo root", () => {
  const config = resolveConfig({}, {});
  assert.equal(config.host, "jetson");
  assert.equal(config.remoteRoot, "easy_debug_bridge");
  assert.equal(config.remotePackage, "easy_debug_bridge/src/easy_debug_bridge");
  assert.equal(config.rosSetup, "Project/rebotarm-ros2-stack/install/setup.bash");
  assert.equal(config.localPackage, join(projectRoot, "bridge", "easy_debug_bridge"));
  assert.equal(remotePathWord("easy_debug_bridge"), `"$HOME"/'easy_debug_bridge'`);
  assert.equal(remotePathWord("/opt/ws"), "'/opt/ws'");
  const build = buildRemoteBuildScript(config);
  assert.match(build, /cd "\$HOME"\/'easy_debug_bridge'/);
  assert.match(build, /source "\$HOME"\/'Project\/rebotarm-ros2-stack\/install\/setup\.bash'/);
  const restart = buildRemoteRestartScript(config);
  assert.match(restart, /pkill -TERM -f "\^\$HOME\/easy_debug_bridge\/install/);
});

test("isSafeRemotePath mirrors Tauri setup-script character rules", () => {
  assert.equal(isSafeRemotePath("/home/robot/easy_debug_bridge"), true);
  assert.equal(isSafeRemotePath("/opt/ros/humble/setup.bash"), true);
  assert.equal(isSafeRemotePath("easy_debug_bridge"), true);
  assert.equal(isSafeRemotePath("ws/install/setup.bash"), true);
  assert.equal(isSafeRemotePath("/tmp/a;b"), false);
  assert.equal(isSafeRemotePath(""), false);
  assert.equal(isSafeRemotePath("/"), false);
  assert.equal(isSafeRemotePath("~/ws"), false);
  assert.equal(isSafeRemotePath(".."), false);
  assert.equal(isSafeRemotePath("ws/../etc"), false);
  assert.equal(isSafeRemotePath("./ws"), false);
  assert.equal(isSafeRemotePath("ws//x"), false);
  assert.equal(isSafeRemotePath("-rf"), false);
});

test("buildRsyncArgs excludes build artifacts and supports dry-run/delete", () => {
  const args = buildRsyncArgs({
    localPackage: "/repo/bridge/easy_debug_bridge",
    remotePackage: "/home/robot/easy_debug_bridge/src/easy_debug_bridge",
    host: "jetson",
    dryRun: true,
    delete: true,
  });
  assert.ok(args.includes("--dry-run"));
  assert.ok(args.includes("--delete"));
  assert.ok(args.includes("--itemize-changes"));
  for (const pattern of RSYNC_EXCLUDES) {
    assert.ok(args.includes(pattern), `missing exclude ${pattern}`);
  }
  assert.equal(args.at(-2), "/repo/bridge/easy_debug_bridge/");
  assert.equal(args.at(-1), "jetson:/home/robot/easy_debug_bridge/src/easy_debug_bridge/");
  assert.equal(args.includes("-e"), true);
});

test("remote build/verify/backup/restart scripts source overlay and mark stages", () => {
  const config = resolveConfig({ host: "jetson" }, {});
  const build = buildRemoteBuildScript(config);
  assert.match(build, /source \/opt\/ros\/humble\/setup\.bash/);
  assert.match(build, /Project\/rebotarm-ros2-stack\/install\/setup\.bash/);
  assert.match(build, /colcon build --symlink-install --packages-select 'easy_debug_bridge'/);
  assert.match(build, /BUILD_OK/);

  const verify = buildRemoteVerifyScript(config);
  assert.match(verify, /easy_debug_bridge\/install\/setup\.bash/);
  assert.match(verify, /RESOLVED_BIN=/);
  assert.match(verify, /127\\.0\\.0\\.1:8765/);
  assert.match(verify, /VERIFY_OK/);

  const backup = buildRemoteBackupScript(config);
  assert.match(backup, /backup/);
  assert.match(backup, /BACKUP_OK/);

  const restart = buildRemoteRestartScript(config);
  assert.match(restart, /RESTART_OK/);
  assert.match(restart, /ros2 run 'easy_debug_bridge' bridge_node/);
  assert.match(restart, /port:=8765/);
  assert.match(restart, /joint_state_topic:='\/stm32\/joint_states'/);
});

test("parseVerifyOutput detects listening, stale process, and ok", () => {
  const ok = parseVerifyOutput(
    [
      "RESOLVED_BIN=/home/robot/easy_debug_bridge/install/easy_debug_bridge/lib/easy_debug_bridge/bridge_node",
      "EXPECTED_PREFIX=/home/robot/easy_debug_bridge/install",
      "LISTEN_LINE=LISTEN 0 128 127.0.0.1:8765 0.0.0.0:* users:((\"bridge_node\",pid=4242,fd=22))",
      "LISTEN_PID=4242",
      "PROC_EXE=/home/robot/easy_debug_bridge/install/easy_debug_bridge/lib/easy_debug_bridge/bridge_node",
      "PROC_START=Mon Oct 12 21:00:00 2026",
      "VERIFY_OK",
    ].join("\n"),
    8765,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.listening, true);
  assert.equal(ok.staleProcess, false);
  assert.equal(ok.listenPid, "4242");

  const stale = parseVerifyOutput(
    [
      "RESOLVED_BIN=/home/robot/easy_debug_bridge/install/easy_debug_bridge/lib/easy_debug_bridge/bridge_node",
      "LISTEN_LINE=LISTEN 0 128 127.0.0.1:8765 0.0.0.0:* users:((\"bridge_node\",pid=9,fd=3))",
      "LISTEN_PID=9",
      "PROC_EXE=/tmp/old_bridge_node",
      "VERIFY_OK",
    ].join("\n"),
    8765,
  );
  assert.equal(stale.staleProcess, true);
  assert.equal(stale.listening, true);

  const missing = parseVerifyOutput("RESOLVED_BIN=MISSING\nLISTEN_LINE=LISTEN_NONE\n", 8765);
  assert.equal(missing.ok, false);
  assert.equal(missing.listening, false);
});

test("summarizeRsyncItemize counts change lines", () => {
  const summary = summarizeRsyncItemize(
    [">f+++++++++ src/bridge_node.cpp", ".d..t...... include/", "deleting old.txt", ""].join("\n"),
  );
  assert.equal(summary.changeCount, 3);
  assert.equal(summary.truncated, false);
});

test("shellQuote escapes single quotes for remote bash", () => {
  assert.equal(shellQuote("a'b"), `'a'\\''b'`);
});

test("assertLocalPackage accepts a minimal package tree", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-deploy-pkg-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "package.xml"), "<package/>");
  await writeFile(join(root, "CMakeLists.txt"), "cmake_minimum_required(VERSION 3.16)\n");
  await mkdir(join(root, "src"));
  await assertLocalPackage(root);
  await assert.rejects(() => assertLocalPackage(join(root, "missing")), DeployStageError);
});

test("deployBridge dry-run compare path does not sync or build", async () => {
  const config = resolveConfig(
    { dryRun: true, host: "jetson", localPackage: "bridge/easy_debug_bridge" },
    {},
  );
  /** @type {string[]} */
  const logs = [];
  /** @type {string[][]} */
  const commands = [];
  const result = await deployBridge(config, {
    log: (message) => logs.push(message),
    runCommandFn: async (command, args) => {
      commands.push([command, ...args]);
      if (command === "rsync") {
        return { code: 0, stdout: ">f.st...... src/bridge_node.cpp\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: `unexpected ${command}` };
    },
    runSshFn: async () => {
      throw new Error("ssh should not run in dry-run");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.compareSummary?.changeCount, 1);
  assert.equal(commands.length, 1);
  assert.equal(commands[0][0], "rsync");
  assert.ok(commands[0].includes("--dry-run"));
  assert.ok(commands[0].includes("--checksum"));
  assert.ok(logs.some((line) => line.includes("[compare]")));
  assert.ok(logs.some((line) => line.includes("no sync/build/restart")));
});

test("deployBridge maps unreachable host during compare to ssh stage", async () => {
  const config = resolveConfig(
    { compareOnly: true, host: "jetson", localPackage: "bridge/easy_debug_bridge" },
    {},
  );
  await assert.rejects(
    () =>
      deployBridge(config, {
        log: () => {},
        runCommandFn: async () => ({
          code: 255,
          stdout: "",
          stderr: "ssh: connect to host 192.168.2.124 port 22: No route to host",
        }),
      }),
    (error) =>
      error instanceof DeployStageError &&
      error.stage === "ssh" &&
      /SSH failed while comparing/.test(error.message),
  );
});

test("deployBridge maps non-SSH rsync errors to compare stage", async () => {
  const config = resolveConfig(
    { compareOnly: true, host: "jetson", localPackage: "bridge/easy_debug_bridge" },
    {},
  );
  await assert.rejects(
    () =>
      deployBridge(config, {
        log: () => {},
        runCommandFn: async () => ({
          code: 23,
          stdout: "",
          stderr: "rsync error: some files/attrs were not transferred",
        }),
      }),
    (error) =>
      error instanceof DeployStageError &&
      error.stage === "compare" &&
      /rsync compare failed/.test(error.message),
  );
});

test("defaults are generic and home-relative", () => {
  assert.equal(DEFAULTS.host, "jetson");
  assert.equal(DEFAULTS.remoteRoot, "easy_debug_bridge");
  assert.equal(DEFAULTS.rosSetup, "Project/rebotarm-ros2-stack/install/setup.bash");
  assert.equal(DEFAULTS.remotePort, 8765);
});

test("buildSshCommandArgs and rsync -e honor ssh port and identity file", () => {
  const args = buildSshCommandArgs({ host: "jetson", sshPort: 2222, identityFile: "/tmp/id" });
  assert.deepEqual(args.slice(0, 4), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.ok(args.includes("-p") && args.includes("2222"));
  assert.ok(args.includes("-i") && args.includes("/tmp/id"));
  const rsync = buildRsyncArgs({
    localPackage: "/repo/bridge/easy_debug_bridge",
    remotePackage: "easy_debug_bridge/src/easy_debug_bridge",
    host: "user@jetson",
    sshPort: 2222,
    identityFile: "/tmp/id",
  });
  const shell = rsync[rsync.indexOf("-e") + 1];
  assert.match(shell, /-p/);
  assert.match(shell, /2222/);
  assert.match(shell, /-i/);
  assert.equal(buildRsyncShell({ host: "jetson" }).startsWith("'ssh'"), true);
});

test("parseArgs accepts --ssh-port and --identity-file", () => {
  const config = parseArgs(["--host", "u@h", "--ssh-port", "2201", "--identity-file", "/tmp/key"]);
  assert.equal(config.host, "u@h");
  assert.equal(config.sshPort, 2201);
  assert.equal(config.identityFile, "/tmp/key");
});
