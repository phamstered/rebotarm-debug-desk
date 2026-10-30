import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { access, constants as fsConstants, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const projectRoot = resolve(dirname(scriptPath), "..");

export const DEFAULTS = Object.freeze({
  // Generic SSH alias; set BRIDGE_DEPLOY_HOST or --host for your Jetson.
  host: "jetson",
  // Relative remote paths are resolved against the remote user's $HOME.
  remoteRoot: "easy_debug_bridge",
  rosSetup: "Project/rebotarm-ros2-stack/install/setup.bash",
  remotePort: 8765,
  packageName: "easy_debug_bridge",
  rosDomainId: 0,
  jointStateTopic: "/stm32/joint_states",
  commandTopic: "/stm32/joint_commands",
  statusTopic: "/stm32/hardware_status",
});

/** Paths excluded from sync so remote build/install/log and junk stay intact. */
export const RSYNC_EXCLUDES = Object.freeze([
  "build/",
  "install/",
  "log/",
  ".git/",
  "__pycache__/",
  "*.pyc",
  ".DS_Store",
  "node_modules/",
  "*.o",
  "*.a",
]);

export class DeployStageError extends Error {
  /**
   * @param {"ssh"|"compare"|"backup"|"sync"|"build"|"verify"|"restart"|"config"} stage
   * @param {string} message
   * @param {{ cause?: unknown, detail?: string }} [options]
   */
  constructor(stage, message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DeployStageError";
    this.stage = stage;
    this.detail = options.detail ?? "";
  }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} [env]
 */
export function parseArgs(argv, env = process.env) {
  const args = [...argv];
  /** @type {Record<string, string|boolean|number>} */
  const flags = {
    dryRun: false,
    compareOnly: false,
    backup: false,
    delete: false,
    skipSync: false,
    skipBuild: false,
    skipVerify: false,
    restart: false,
    help: false,
    sshPort: 0,
    identityFile: "",
  };

  while (args.length > 0) {
    const token = args.shift();
    if (token === undefined) break;
    switch (token) {
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--compare-only":
        flags.compareOnly = true;
        break;
      case "--backup":
        flags.backup = true;
        break;
      case "--delete":
        flags.delete = true;
        break;
      case "--skip-sync":
        flags.skipSync = true;
        break;
      case "--skip-build":
        flags.skipBuild = true;
        break;
      case "--skip-verify":
        flags.skipVerify = true;
        break;
      case "--restart":
        flags.restart = true;
        break;
      case "--host":
        flags.host = requireValue(token, args.shift());
        break;
      case "--remote":
        flags.remoteRoot = requireValue(token, args.shift());
        break;
      case "--ros-setup":
        flags.rosSetup = requireValue(token, args.shift());
        break;
      case "--port":
        flags.remotePort = Number(requireValue(token, args.shift()));
        break;
      case "--ros-domain-id":
        flags.rosDomainId = Number(requireValue(token, args.shift()));
        break;
      case "--local-package":
        flags.localPackage = requireValue(token, args.shift());
        break;
      case "--ssh-port":
        flags.sshPort = Number(requireValue(token, args.shift()));
        break;
      case "--identity-file":
        flags.identityFile = requireValue(token, args.shift());
        break;
      default:
        throw new DeployStageError("config", `Unknown argument: ${token}`);
    }
  }

  return resolveConfig(flags, env);
}

/**
 * @param {Record<string, string|boolean|number|undefined>} flags
 * @param {NodeJS.ProcessEnv} env
 */
export function resolveConfig(flags, env = process.env) {
  const host = String(flags.host ?? env.BRIDGE_DEPLOY_HOST ?? DEFAULTS.host);
  const remoteRoot = String(
    flags.remoteRoot ?? env.BRIDGE_DEPLOY_REMOTE ?? DEFAULTS.remoteRoot,
  );
  const rosSetup = String(
    flags.rosSetup ?? env.BRIDGE_DEPLOY_ROS_SETUP ?? DEFAULTS.rosSetup,
  );
  const remotePort = Number(
    flags.remotePort ?? env.BRIDGE_DEPLOY_PORT ?? DEFAULTS.remotePort,
  );
  const rosDomainId = Number(
    flags.rosDomainId ?? env.BRIDGE_DEPLOY_ROS_DOMAIN_ID ?? DEFAULTS.rosDomainId,
  );
  const localPackage = resolve(
    projectRoot,
    String(
      flags.localPackage ??
        env.BRIDGE_DEPLOY_LOCAL ??
        join("bridge", DEFAULTS.packageName),
    ),
  );
  const remotePackage = `${remoteRoot.replace(/\/$/, "")}/src/${DEFAULTS.packageName}`;

  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new DeployStageError("config", `Invalid remote port: ${remotePort}`);
  }
  if (!Number.isInteger(rosDomainId) || rosDomainId < 0 || rosDomainId > 232) {
    throw new DeployStageError("config", `Invalid ROS_DOMAIN_ID: ${rosDomainId}`);
  }
  if (!isSafeRemotePath(remoteRoot) || !isSafeRemotePath(rosSetup)) {
    throw new DeployStageError(
      "config",
      "Remote root or ROS setup path is unsafe (allowed: absolute or $HOME-relative paths of [A-Za-z0-9._-/], no ., .., ~ or leading -)",
    );
  }
  if (!host.trim() || host.startsWith("-") || /[\s;|&$`'"\\<>()]/.test(host)) {
    throw new DeployStageError("config", `Unsafe SSH host: ${host}`);
  }

  const sshPort = Number(flags.sshPort ?? env.BRIDGE_DEPLOY_SSH_PORT ?? 0);
  const identityFile = String(flags.identityFile ?? env.BRIDGE_DEPLOY_IDENTITY_FILE ?? "").trim();
  if (sshPort !== 0 && (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)) {
    throw new DeployStageError("config", `Invalid SSH port: ${sshPort}`);
  }
  if (identityFile) {
    if (identityFile.startsWith("-") || /[\s;|&$\`'"\\<>()]/.test(identityFile)) {
      throw new DeployStageError("config", `Unsafe identity file path: ${identityFile}`);
    }
  }

  return {
    host,
    remoteRoot: remoteRoot.replace(/\/$/, ""),
    remotePackage,
    rosSetup,
    remotePort,
    rosDomainId,
    sshPort,
    identityFile,
    packageName: DEFAULTS.packageName,
    localPackage,
    jointStateTopic: DEFAULTS.jointStateTopic,
    commandTopic: DEFAULTS.commandTopic,
    statusTopic: DEFAULTS.statusTopic,
    dryRun: Boolean(flags.dryRun),
    compareOnly: Boolean(flags.compareOnly),
    backup: Boolean(flags.backup),
    delete: Boolean(flags.delete),
    skipSync: Boolean(flags.skipSync),
    skipBuild: Boolean(flags.skipBuild),
    skipVerify: Boolean(flags.skipVerify),
    restart: Boolean(flags.restart),
    help: Boolean(flags.help),
  };
}

/**
 * Remote paths may be absolute or relative to the remote user's $HOME.
 * Only [A-Za-z0-9._-/] are allowed; `~`, `..`/`.` segments, empty segments
 * and segments starting with `-` are rejected.
 * @param {string} path
 */
export function isSafeRemotePath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false;
  if (![...path].every((character) => /[A-Za-z0-9._\-/]/.test(character))) return false;
  const body = path.startsWith("/") ? path.slice(1) : path;
  const trimmed = body.endsWith("/") ? body.slice(0, -1) : body;
  if (trimmed.length === 0) return false;
  return trimmed
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("-"));
}

/**
 * Shell word for a validated remote path: absolute paths are quoted as-is,
 * relative paths are anchored at the remote "$HOME".
 * @param {string} path
 */

/**
 * SSH argv fragments shared by direct ssh and rsync -e.
 * @param {{ host: string, sshPort?: number, identityFile?: string }} config
 */
export function buildSshCommandArgs(config) {
  /** @type {string[]} */
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
  const sshPort = Number(config.sshPort ?? 0);
  if (Number.isInteger(sshPort) && sshPort > 0) {
    args.push("-p", String(sshPort));
  }
  const identityFile = String(config.identityFile ?? "").trim();
  if (identityFile) {
    args.push("-i", identityFile);
  }
  return args;
}

/** @param {{ host: string, sshPort?: number, identityFile?: string }} config */
export function buildRsyncShell(config) {
  return ["ssh", ...buildSshCommandArgs(config)].map(shellQuote).join(" ");
}

export function remotePathWord(path) {
  return path.startsWith("/") ? shellQuote(path) : `"$HOME"/${shellQuote(path)}`;
}

/**
 * @param {object} options
 * @param {string} options.localPackage
 * @param {string} options.remotePackage
 * @param {string} options.host
 * @param {boolean} [options.dryRun]
 * @param {boolean} [options.delete]
 * @param {readonly string[]} [options.excludes]
 */
export function buildRsyncArgs({
  localPackage,
  remotePackage,
  host,
  dryRun = false,
  delete: deleteExtra = false,
  excludes = RSYNC_EXCLUDES,
  sshPort = 0,
  identityFile = "",
}) {
  const source = localPackage.endsWith("/") ? localPackage : `${localPackage}/`;
  const dest = `${host}:${remotePackage}/`;
  /** @type {string[]} */
  const args = ["-az", "--itemize-changes"];
  if (dryRun) args.push("--dry-run");
  if (deleteExtra) args.push("--delete");
  for (const pattern of excludes) {
    args.push("--exclude", pattern);
  }
  args.push(
    "-e",
    buildRsyncShell({ host, sshPort, identityFile }),
  );
  args.push(source, dest);
  return args;
}

/** @param {{ remoteRoot: string, remotePackage: string, packageName: string }} config */
export function buildRemoteBackupScript(config) {
  const stamp = "$(date +%Y%m%d-%H%M%S)";
  return [
    "set -eo pipefail",
    `ROOT=${remotePathWord(config.remoteRoot)}`,
    `PKG=${remotePathWord(config.remotePackage)}`,
    `NAME=${shellQuote(config.packageName)}`,
    'if [ ! -d "$PKG" ]; then echo "Remote package missing: $PKG" >&2; exit 1; fi',
    `BACKUP_DIR="$ROOT/backup"`,
    'mkdir -p "$BACKUP_DIR"',
    `ARCHIVE="$BACKUP_DIR/\${NAME}-${stamp}.tar.gz"`,
    'tar -C "$(dirname "$PKG")" -czf "$ARCHIVE" "$(basename "$PKG")"',
    'echo "BACKUP_OK $ARCHIVE"',
  ].join("\n");
}

/** @param {{ remoteRoot: string, rosSetup: string, packageName: string }} config */
export function buildRemoteBuildScript(config) {
  return [
    "set -eo pipefail",
    "source /opt/ros/humble/setup.bash",
    `if [ -f ${remotePathWord(config.rosSetup)} ]; then source ${remotePathWord(config.rosSetup)}; fi`,
    `cd ${remotePathWord(config.remoteRoot)}`,
    "mkdir -p src",
    `colcon build --symlink-install --packages-select ${shellQuote(config.packageName)} --event-handlers console_direct+`,
    'echo "BUILD_OK"',
  ].join("\n");
}

/** @param {{ remoteRoot: string, rosSetup: string, remotePort: number, packageName: string }} config */
export function buildRemoteVerifyScript(config) {
  const port = String(config.remotePort);
  return [
    "set -eo pipefail",
    "source /opt/ros/humble/setup.bash",
    `if [ -f ${remotePathWord(config.rosSetup)} ]; then source ${remotePathWord(config.rosSetup)}; fi`,
    `source ${remotePathWord(`${config.remoteRoot}/install/setup.bash`)}`,
    `PKG=${shellQuote(config.packageName)}`,
    'BIN="$(ros2 pkg executables "$PKG" 2>/dev/null | awk \'/bridge_node/{print $2; exit}\')"',
    'PREFIX="$(ros2 pkg prefix "$PKG" 2>/dev/null || true)"',
    'if [ -n "$PREFIX" ] && [ -x "$PREFIX/lib/$PKG/bridge_node" ]; then',
    '  RESOLVED="$PREFIX/lib/$PKG/bridge_node"',
    'elif [ -n "$BIN" ] && [ -x "$BIN" ]; then',
    '  RESOLVED="$BIN"',
    "else",
    '  RESOLVED=""',
    "fi",
    'echo "RESOLVED_BIN=${RESOLVED:-MISSING}"',
    `echo "EXPECTED_PREFIX="${remotePathWord(config.remoteRoot)}"/install"`,
    `LISTEN="$(ss -ltnp 2>/dev/null | awk '/127\\.0\\.0\\.1:${port}[[:space:]]/{print; found=1} END{if(!found) print \"LISTEN_NONE\"}' || true)"`,
    'echo "LISTEN_LINE=$LISTEN"',
    "PID=\"$(echo \"$LISTEN\" | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | head -n1 || true)\"",
    'if [ -n "${PID:-}" ]; then',
    '  echo "LISTEN_PID=$PID"',
    '  if [ -r "/proc/$PID/exe" ]; then echo "PROC_EXE=$(readlink -f /proc/$PID/exe)"; else echo "PROC_EXE=UNREADABLE"; fi',
    '  echo "PROC_START=$(ps -o lstart= -p "$PID" 2>/dev/null || true)"',
    "else",
    '  echo "LISTEN_PID="',
    '  echo "PROC_EXE="',
    "fi",
    'if [ -z "${RESOLVED:-}" ] || [ "$RESOLVED" = "MISSING" ]; then echo "VERIFY_FAIL missing installed bridge_node" >&2; exit 2; fi',
    `case "$RESOLVED" in ${remotePathWord(config.remoteRoot)}/install/*) ;; *) echo "VERIFY_WARN resolved binary outside expected install tree: $RESOLVED" >&2 ;; esac`,
    'echo "VERIFY_OK"',
  ].join("\n");
}

/**
 * Restart mirrors the desktop start_session remote command: stop the installed
 * bridge_node, wait for the loopback port, then nohup ros2 run again.
 * @param {ReturnType<typeof resolveConfig>} config
 */
export function buildRemoteRestartScript(config) {
  const port = String(config.remotePort);
  return [
    "set -eo pipefail",
    "source /opt/ros/humble/setup.bash",
    `if [ -f ${remotePathWord(config.rosSetup)} ]; then source ${remotePathWord(config.rosSetup)}; fi`,
    `source ${remotePathWord(`${config.remoteRoot}/install/setup.bash`)}`,
    `if [ -z "\${FASTRTPS_DEFAULT_PROFILES_FILE:-}\${FASTDDS_DEFAULT_PROFILES_FILE:-}" ] && [ -f ${remotePathWord(`${config.remoteRoot}/install/${config.packageName}/share/${config.packageName}/config/fastdds_udp.xml`)} ]; then export FASTRTPS_DEFAULT_PROFILES_FILE=${remotePathWord(`${config.remoteRoot}/install/${config.packageName}/share/${config.packageName}/config/fastdds_udp.xml`)}; fi`,
    `pkill -TERM -f "^${config.remoteRoot.startsWith("/") ? "" : "$HOME/"}${shellEscapeRegex(`${config.remoteRoot}/install/${config.packageName}/lib/${config.packageName}/bridge_node`)} " >/dev/null 2>&1 || true`,
    `for attempt in 1 2 3 4 5 6 7 8 9 10; do if ! ss -ltn | grep -q ":${port} "; then break; fi; sleep 0.1; done`,
    `if ss -ltn | grep -q ":${port} "; then echo "RESTART_FAIL port ${port} still occupied" >&2; exit 1; fi`,
    `ROS_DOMAIN_ID=${config.rosDomainId} nohup ros2 run ${shellQuote(config.packageName)} bridge_node --ros-args -p port:=${port} -p joint_state_topic:=${shellQuote(config.jointStateTopic)} -p command_topic:=${shellQuote(config.commandTopic)} -p status_topic:=${shellQuote(config.statusTopic)} >/tmp/easy_debug_bridge.log 2>&1 </dev/null &`,
    'for attempt in $(seq 1 100); do',
    `  if ss -ltn | grep -q "127.0.0.1:${port}"; then echo "RESTART_OK"; exit 0; fi`,
    '  sleep 0.1',
    'done',
    `echo "RESTART_FAIL bridge did not listen on 127.0.0.1:${port} within 10 seconds" >&2`,
    'tail -n 40 /tmp/easy_debug_bridge.log >&2 || true',
    'exit 1',
  ].join("\n");
}

/**
 * @param {string} output
 * @param {number} port
 */
export function parseVerifyOutput(output, port) {
  const lines = output.split(/\r?\n/);
  /** @type {Record<string, string>} */
  const fields = {};
  for (const line of lines) {
    const match = /^(RESOLVED_BIN|EXPECTED_PREFIX|LISTEN_LINE|LISTEN_PID|PROC_EXE|PROC_START|VERIFY_OK|VERIFY_FAIL|VERIFY_WARN)=(.*)$/.exec(
      line,
    );
    if (match) fields[match[1]] = match[2];
    if (line === "VERIFY_OK") fields.VERIFY_OK = "1";
    if (line.startsWith("VERIFY_FAIL")) fields.VERIFY_FAIL = line;
    if (line.startsWith("VERIFY_WARN")) fields.VERIFY_WARN = line;
  }

  const listening =
    Boolean(fields.LISTEN_LINE) &&
    fields.LISTEN_LINE !== "LISTEN_NONE" &&
    fields.LISTEN_LINE.includes(`127.0.0.1:${port}`);

  const resolved = fields.RESOLVED_BIN ?? "";
  const procExe = fields.PROC_EXE ?? "";
  const staleProcess =
    listening &&
    Boolean(resolved) &&
    resolved !== "MISSING" &&
    Boolean(procExe) &&
    procExe !== "UNREADABLE" &&
    procExe !== resolved;

  return {
    resolvedBin: resolved,
    expectedPrefix: fields.EXPECTED_PREFIX ?? "",
    listenLine: fields.LISTEN_LINE ?? "",
    listenPid: fields.LISTEN_PID ?? "",
    procExe,
    procStart: fields.PROC_START ?? "",
    listening,
    staleProcess,
    ok: fields.VERIFY_OK === "1" && resolved !== "" && resolved !== "MISSING",
    warn: fields.VERIFY_WARN ?? "",
    fail: fields.VERIFY_FAIL ?? "",
  };
}

/** @param {string} itemizeOutput */
export function summarizeRsyncItemize(itemizeOutput) {
  const lines = itemizeOutput
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
  const changes = lines.filter((line) => /^[*<>ch\.]/.test(line) || line.startsWith("deleting "));
  return {
    changeCount: changes.length,
    changes: changes.slice(0, 50),
    truncated: changes.length > 50,
  };
}

export function usageText() {
  return `Usage: node scripts/deploy-bridge.mjs [options]

Deploy bridge/easy_debug_bridge to a Jetson colcon workspace, build, and verify.

Options:
  --host <name>           SSH host (default: ${DEFAULTS.host} or BRIDGE_DEPLOY_HOST)
  --remote <path>         Remote workspace root, absolute or $HOME-relative (default: ${DEFAULTS.remoteRoot})
  --ros-setup <path>      Robot overlay setup.bash (default: ${DEFAULTS.rosSetup})
  --port <n>              Bridge listen port (default: ${DEFAULTS.remotePort})
  --ros-domain-id <n>     ROS_DOMAIN_ID for --restart (default: ${DEFAULTS.rosDomainId})
  --local-package <path>  Local package path (default: bridge/${DEFAULTS.packageName})
  --ssh-port <n>          SSH port (default: ssh config / 22; BRIDGE_DEPLOY_SSH_PORT)
  --identity-file <path>  SSH identity file (BRIDGE_DEPLOY_IDENTITY_FILE)
  --dry-run               Compare only (rsync --dry-run); no sync/build/restart
  --compare-only          Same as --dry-run
  --backup                Tar remote package under <remote>/backup/ before sync
  --delete                Pass rsync --delete (removes remote-only files under package)
  --skip-sync             Do not rsync (build/verify existing remote tree)
  --skip-build            Skip colcon build
  --skip-verify           Skip installed-binary / listener checks
  --restart               Stop and restart the installed Bridge (explicit confirmation)
  -h, --help              Show this help

Environment overrides: BRIDGE_DEPLOY_HOST, BRIDGE_DEPLOY_REMOTE,
BRIDGE_DEPLOY_ROS_SETUP, BRIDGE_DEPLOY_PORT, BRIDGE_DEPLOY_ROS_DOMAIN_ID,
BRIDGE_DEPLOY_LOCAL.

Built-in defaults are generic; override them with the flags/env above.
Relative --remote/--ros-setup paths are resolved against the remote user's
$HOME; the local package path is resolved against the repository root. Current defaults: SSH host ${DEFAULTS.host}, remote
${DEFAULTS.remoteRoot}, overlay ${DEFAULTS.rosSetup}, port ${DEFAULTS.remotePort}.
Sync targets <remote>/src/${DEFAULTS.packageName}/ and does not use --delete
unless requested, so remote-only custom files are preserved.

Without --restart, a successful build still leaves any already-running Bridge
process untouched; use --restart only after comparing verify output.`;
}

/** @param {string} flag @param {string|undefined} value */
function requireValue(flag, value) {
  if (value === undefined || value.startsWith("--")) {
    throw new DeployStageError("config", `Missing value for ${flag}`);
  }
  return value;
}

/** @param {string} value */
export function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** @param {string} value */
function shellEscapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ input?: string }} [options]
 */
export function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    const started = Date.now();
    const heartbeat = options.onProgress ? setInterval(() => {
      options.onProgress(`[progress] 远端任务仍在执行，已耗时 ${Math.floor((Date.now() - started) / 1000)} 秒；等待下一条构建/校验输出`);
    }, options.progressIntervalMs ?? 10000) : null;
    const buffers = { stdout: "", stderr: "" };
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const stream = (name, chunks, chunk) => {
      chunks.push(chunk);
      if (!options.onProgress) return;
      buffers[name] += decoders[name].write(chunk);
      const lines = buffers[name].split(/\r?\n/);
      buffers[name] = lines.pop();
      for (const line of lines) if (line) options.onProgress(`[remote] ${line}`);
    };
    child.stdout.on("data", (chunk) => stream("stdout", stdoutChunks, chunk));
    child.stderr.on("data", (chunk) => stream("stderr", stderrChunks, chunk));
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
    child.on("error", (error) => { clearInterval(heartbeat); reject(error); });
    child.on("close", (code) => {
      clearInterval(heartbeat);
      if (options.onProgress) for (const name of Object.keys(buffers)) {
        const tail = buffers[name] + decoders[name].end();
        if (tail) options.onProgress(`[remote] ${tail}`);
      }
      resolvePromise({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

/** @param {ReturnType<typeof resolveConfig>} config @param {string} remoteScript */
export async function runSsh(config, remoteScript) {
  const result = await runCommand("ssh", [
    ...buildSshCommandArgs(config),
    config.host,
    "bash",
    "-lc",
    shellQuote(remoteScript),
  ]);
  if (result.code !== 0) {
    throw new DeployStageError(
      "ssh",
      `SSH command failed on ${config.host} (exit ${result.code})`,
      { detail: result.stderr.trim() || result.stdout.trim() },
    );
  }
  return result;
}

/** @param {string} localPackage */
export async function assertLocalPackage(localPackage) {
  try {
    await access(localPackage, fsConstants.R_OK);
    const info = await stat(localPackage);
    if (!info.isDirectory()) {
      throw new DeployStageError("config", `Local package is not a directory: ${localPackage}`);
    }
  } catch (error) {
    if (error instanceof DeployStageError) throw error;
    throw new DeployStageError("config", `Local package missing or unreadable: ${localPackage}`, {
      cause: error,
    });
  }
  for (const required of ["package.xml", "CMakeLists.txt", "src"]) {
    try {
      await access(join(localPackage, required), fsConstants.R_OK);
    } catch (error) {
      throw new DeployStageError(
        "config",
        `Local package incomplete (missing ${required}): ${localPackage}`,
        { cause: error },
      );
    }
  }
}

/**
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {{ runCommandFn?: typeof runCommand, runSshFn?: typeof runSsh, log?: (message: string) => void }} [deps]
 */
export async function deployBridge(config, deps = {}) {
  const runCommandFn = deps.runCommandFn ?? runCommand;
  const log = deps.log ?? console.log;
  const runSshFn = deps.runSshFn ?? ((cfg, script) => runSshWith(cfg, script,
    (command, args) => runCommandFn(command, args, { onProgress: log })));

  if (config.help) {
    log(usageText());
    return { ok: true, skipped: true };
  }

  log(`[config] host=${config.host} remote=${config.remoteRoot} package=${config.localPackage}`);
  log(`[config] ros_setup=${config.rosSetup} port=${config.remotePort} restart=${config.restart}`);
  if (config.sshPort) log(`[config] ssh_port=${config.sshPort}`);
  if (config.identityFile) log(`[config] identity_file=${config.identityFile}`);

  await assertLocalPackage(config.localPackage);

  const compareOnly = config.dryRun || config.compareOnly;
  /** @type {{ changeCount: number, changes: string[], truncated: boolean } | null} */
  let compareSummary = null;

  if (!config.skipSync || compareOnly) {
    log("[compare] rsync dry-run (checksum itemize)...");
    try {
      const dryArgs = buildRsyncArgs({
        localPackage: config.localPackage,
        remotePackage: config.remotePackage,
        host: config.host,
        dryRun: true,
        delete: config.delete,
        sshPort: config.sshPort,
        identityFile: config.identityFile,
      });
      // Prefer checksum for compare; fall back without if remote rsync is old.
      const compareArgs = ["--checksum", ...dryArgs];
      let compare = await runCommandFn("rsync", compareArgs);
      if (compare.code !== 0 && /unknown option|checksum/i.test(compare.stderr)) {
        compare = await runCommandFn("rsync", dryArgs);
      }
      if (compare.code !== 0) {
        const detail = compare.stderr.trim() || compare.stdout.trim();
        const sshFailure = /no route to host|connection refused|connection timed out|could not resolve|permission denied \(publickey\)|host key verification failed/i.test(
          detail,
        );
        throw new DeployStageError(
          sshFailure ? "ssh" : "compare",
          sshFailure
            ? `SSH failed while comparing with ${config.host} (exit ${compare.code})`
            : `rsync compare failed (exit ${compare.code})`,
          { detail },
        );
      }
      compareSummary = summarizeRsyncItemize(compare.stdout);
      log(`[compare] ${compareSummary.changeCount} change(s) would sync`);
      for (const line of compareSummary.changes) log(`  ${line}`);
      if (compareSummary.truncated) log("  ... truncated");
    } catch (error) {
      if (error instanceof DeployStageError) throw error;
      throw new DeployStageError("ssh", `Cannot reach ${config.host} for rsync compare`, {
        cause: error,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (compareOnly) {
    log("[compare] dry-run complete; no sync/build/restart performed");
    return { ok: true, compareSummary, dryRun: true };
  }

  if (config.backup && !config.skipSync) {
    log("[backup] archiving remote package...");
    try {
      const backup = await runSshFn(config, buildRemoteBackupScript(config));
      const line = backup.stdout
        .split(/\r?\n/)
        .find((entry) => entry.startsWith("BACKUP_OK "));
      log(line ? `[backup] ${line.slice("BACKUP_OK ".length)}` : "[backup] done");
    } catch (error) {
      rethrowAsStage(error, "backup", "Remote backup failed");
    }
  }

  if (!config.skipSync) {
    log(`[sync] rsync → ${config.host}:${config.remotePackage}/ (delete=${config.delete})`);
    try {
      await runSshFn(
        config,
        [
          "set -eo pipefail",
          `mkdir -p ${remotePathWord(config.remotePackage)}`,
        ].join("\n"),
      );
      const syncArgs = buildRsyncArgs({
        localPackage: config.localPackage,
        remotePackage: config.remotePackage,
        host: config.host,
        dryRun: false,
        delete: config.delete,
        sshPort: config.sshPort,
        identityFile: config.identityFile,
      });
      const sync = await runCommandFn("rsync", syncArgs);
      if (sync.code !== 0) {
        throw new DeployStageError("sync", `rsync sync failed (exit ${sync.code})`, {
          detail: sync.stderr.trim() || sync.stdout.trim(),
        });
      }
      const synced = summarizeRsyncItemize(sync.stdout);
      log(`[sync] transferred ${synced.changeCount} path(s)`);
    } catch (error) {
      rethrowAsStage(error, "sync", "Sync failed");
    }
  }

  if (!config.skipBuild) {
    log("[build] remote colcon build...");
    try {
      const build = await runSshFn(config, buildRemoteBuildScript(config));
      if (!build.stdout.includes("BUILD_OK")) {
        throw new DeployStageError("build", "colcon build finished without BUILD_OK marker", {
          detail: build.stderr.trim() || build.stdout.trim(),
        });
      }
      log("[build] BUILD_OK");
    } catch (error) {
      rethrowAsStage(error, "build", "Remote colcon build failed");
    }
  }

  /** @type {ReturnType<typeof parseVerifyOutput> | null} */
  let verify = null;
  if (!config.skipVerify) {
    log("[verify] installed binary and listener...");
    try {
      const result = await runSshFn(config, buildRemoteVerifyScript(config));
      verify = parseVerifyOutput(`${result.stdout}\n${result.stderr}`, config.remotePort);
      log(`[verify] resolved=${verify.resolvedBin || "MISSING"}`);
      log(`[verify] listening=${verify.listening} pid=${verify.listenPid || "-"} exe=${verify.procExe || "-"}`);
      if (verify.warn) log(`[verify] ${verify.warn}`);
      if (!verify.ok) {
        throw new DeployStageError(
          "verify",
          verify.fail || "Installed bridge_node could not be resolved",
          { detail: result.stdout.trim() },
        );
      }
      if (verify.staleProcess) {
        log(
          "[verify] WARNING: process on port does not match resolved install binary; pass --restart to replace it",
        );
      } else if (!verify.listening) {
        log(
          `[verify] WARNING: nothing listening on 127.0.0.1:${config.remotePort}; desktop connect or --restart will start Bridge`,
        );
      }
    } catch (error) {
      rethrowAsStage(error, "verify", "Verify failed");
    }
  }

  if (config.restart) {
    log("[restart] stopping and starting installed Bridge (--restart confirmation)...");
    try {
      const result = await runSshFn(config, buildRemoteRestartScript(config));
      if (!result.stdout.includes("RESTART_OK")) {
        throw new DeployStageError("restart", "Restart finished without RESTART_OK", {
          detail: result.stderr.trim() || result.stdout.trim(),
        });
      }
      log("[restart] RESTART_OK");
      if (verify?.staleProcess) {
        log("[restart] previous stale listener should now be replaced");
      }
    } catch (error) {
      rethrowAsStage(error, "restart", "Bridge restart failed — old process may still be running");
    }
  } else if (verify?.staleProcess) {
    log("[restart] skipped (no --restart); running Bridge may still be the old binary");
  }

  log("[done] deploy stages finished");
  return { ok: true, compareSummary, verify };
}

/**
 * @param {ReturnType<typeof resolveConfig>} config
 * @param {string} remoteScript
 * @param {typeof runCommand} runCommandFn
 */
async function runSshWith(config, remoteScript, runCommandFn) {
  const result = await runCommandFn("ssh", [
    ...buildSshCommandArgs(config),
    config.host,
    "bash",
    "-lc",
    shellQuote(remoteScript),
  ]);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    const stage = /BUILD_|colcon|cmake/i.test(detail)
      ? "build"
      : /VERIFY_|RESOLVED_BIN|LISTEN_/i.test(detail)
        ? "verify"
        : /RESTART_/i.test(detail)
          ? "restart"
          : /BACKUP_/i.test(detail)
            ? "backup"
            : "ssh";
    throw new DeployStageError(
      stage,
      `Remote ${stage} failed on ${config.host} (exit ${result.code})`,
      { detail },
    );
  }
  return result;
}

/**
 * @param {unknown} error
 * @param {"ssh"|"compare"|"backup"|"sync"|"build"|"verify"|"restart"|"config"} stage
 * @param {string} fallbackMessage
 */
function rethrowAsStage(error, stage, fallbackMessage) {
  if (error instanceof DeployStageError) {
    if (error.stage === "ssh" && stage !== "ssh") {
      throw new DeployStageError(stage, `${fallbackMessage}: ${error.message}`, {
        detail: error.detail,
        cause: error,
      });
    }
    throw error;
  }
  throw new DeployStageError(stage, fallbackMessage, {
    cause: error,
    detail: error instanceof Error ? error.message : String(error),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const config = parseArgs(process.argv.slice(2));
    await deployBridge(config);
  } catch (error) {
    if (error instanceof DeployStageError) {
      console.error(`[${error.stage}] ${error.message}`);
      if (error.detail) console.error(error.detail);
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  }
}
