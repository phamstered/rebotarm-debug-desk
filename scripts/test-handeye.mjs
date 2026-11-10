import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "handeye-test-"));
try {
  const flags = execFileSync("pkg-config", ["--cflags", "--libs", "opencv4"], {
    encoding: "utf8",
  })
    .trim()
    .split(/\s+/);
  execFileSync(
    process.env.CXX || "c++",
    [
      "-std=c++17",
      "-O1",
      ...(process.platform === "darwin" ? ["-I/opt/homebrew/include"] : []),
      "native/handeye/test.cpp",
      "-o",
      join(dir, "test"),
      ...flags,
    ],
    { stdio: "inherit" },
  );
  execFileSync(join(dir, "test"), [], { stdio: "inherit" });
  execFileSync(
    "python3",
    ["-m", "unittest", "discover", "-s", "scripts/handeye", "-p", "test_*.py"],
    { stdio: "inherit" },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
