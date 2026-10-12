import { cp, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const appName = "Robot Console.app";
const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = resolve(dirname(scriptPath), "..");
const builtApp = join(projectRoot, "src-tauri", "target", "release", "bundle", "macos", appName);

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function installMacApp(source = builtApp, applicationsDir = "/Applications") {
  if (basename(source) !== appName) throw new Error(`Unexpected app bundle: ${source}`);
  if (!(await stat(source)).isDirectory()) throw new Error(`Not an app bundle: ${source}`);
  if (!(await stat(applicationsDir)).isDirectory()) {
    throw new Error(`Applications directory does not exist: ${applicationsDir}`);
  }

  const installation = join(applicationsDir, appName);
  const stagingDir = await mkdtemp(join(applicationsDir, ".robot-console-install-"));
  const stagedApp = join(stagingDir, appName);
  const previousApp = join(stagingDir, "previous.app");
  let previousMoved = false;
  let installed = false;
  let preserveStaging = false;

  try {
    await cp(source, stagedApp, { recursive: true, preserveTimestamps: true });
    if (await exists(installation)) {
      await rename(installation, previousApp);
      previousMoved = true;
    }
    await rename(stagedApp, installation);
    installed = true;
    return installation;
  } catch (error) {
    if (previousMoved && !installed) {
      try {
        await rename(previousApp, installation);
        previousMoved = false;
      } catch (rollbackError) {
        preserveStaging = true;
        throw new AggregateError(
          [error, rollbackError],
          `Installation and rollback failed; previous app remains at ${previousApp}`,
        );
      }
    }
    throw error;
  } finally {
    if (!preserveStaging) await rm(stagingDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.platform !== "darwin") {
    console.error("install:mac can only run on macOS");
    process.exitCode = 1;
  } else {
    try {
      const installed = await installMacApp();
      console.log(`Installed ${installed}`);
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
