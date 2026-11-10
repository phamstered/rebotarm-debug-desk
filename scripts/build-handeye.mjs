import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  copyFileSync,
  chmodSync,
  readdirSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "native/build");
const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const pkg = (flag) => run("pkg-config", [flag, "opencv4"]).trim();
mkdirSync(out, { recursive: true });
const prefix = pkg("--variable=prefix");
const flags = pkg("--cflags").split(/\s+/).filter(Boolean);
if (process.platform === "darwin") flags.push("-I/opt/homebrew/include");
const libs = [
  "calib3d",
  "aruco",
  "objdetect",
  "imgcodecs",
  "imgproc",
  "core",
].map((n) => `-lopencv_${n}`);
const target = join(out, "handeye_solver");
execFileSync(
  process.env.CXX || "c++",
  [
    "-std=c++17",
    "-O2",
    ...flags,
    join(root, "native/handeye/main.cpp"),
    "-o",
    target,
    `-L${prefix}/lib`,
    ...libs,
  ],
  { stdio: "inherit" },
);
if (process.argv.includes("--bundle") && process.platform === "darwin") {
  const libdir = join(out, "lib");
  rmSync(libdir, { recursive: true, force: true });
  mkdirSync(libdir);
  const processed = new Set();
  const sources = new Map();
  const dependencies = (file) =>
    run("otool", ["-L", file])
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(" (")[0])
      .filter(Boolean);
  function bundle(file, original, isExe = false) {
    if (processed.has(file)) return;
    processed.add(file);
    for (const dep of dependencies(file)) {
      if (!isExe && basename(dep) === basename(file)) continue;
      if (dep.startsWith("/System/") || dep.startsWith("/usr/lib/")) continue;
      let source = dep;
      if (dep.startsWith("@rpath/"))
        source =
          [
            join(dirname(realpathSync(original)), basename(dep)),
            join(prefix, "lib", basename(dep)),
          ].find(existsSync) || dep;
      if (dep.startsWith("@loader_path/"))
        source = resolve(dirname(original), dep.slice("@loader_path/".length));
      if (!existsSync(source))
        throw new Error(`Cannot bundle dependency ${dep} from ${file}`);
      const name = basename(source),
        dest = join(libdir, name);
      if (sources.has(name) && sources.get(name) !== realpathSync(source))
        throw new Error(`Conflicting dylib ${name}`);
      // Homebrew bottles may be read-only. Tauri must be able to replace these
      // generated resources on subsequent cargo builds.
      if (!sources.has(name)) {
        sources.set(name, realpathSync(source));
        copyFileSync(source, dest);
        chmodSync(dest, 0o644);
        bundle(dest, source);
      }
      run("install_name_tool", [
        "-change",
        dep,
        `@loader_path/${isExe ? "lib/" : ""}${name}`,
        file,
      ]);
    }
    if (!isExe)
      run("install_name_tool", ["-id", `@rpath/${basename(file)}`, file]);
    run("codesign", ["--force", "--sign", "-", file]);
  }
  bundle(target, target, true);
  for (const name of readdirSync(libdir)) {
    const bad = dependencies(join(libdir, name)).find(
      (p) => p.startsWith("/opt/") || p.startsWith("/usr/local/"),
    );
    if (bad) throw new Error(`Unbundled dependency ${bad}`);
  }
  console.log(`Bundled hand-eye engine with ${sources.size} dylibs`);
}
console.log(target);
