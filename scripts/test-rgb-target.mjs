import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const dir=mkdtempSync(join(tmpdir(),"rgb-target-test-"));
try {
 const flags=execFileSync("pkg-config",["--cflags","--libs","opencv4"],{encoding:"utf8"}).trim().split(/\s+/);
 const includes=process.platform==="darwin"?["-I/opt/homebrew/include"]:[];
 const binary=join(dir,"test");
 execFileSync("c++",["-std=c++17","-pthread","-Wall","-Wextra","-DEASY_DEBUG_HAS_OPENCV=1","-Ibridge/easy_debug_bridge/include",...includes,"bridge/easy_debug_bridge/src/rgb_target.cpp","bridge/easy_debug_bridge/test/test_rgb_target.cpp",...flags,"-o",binary],{stdio:"inherit"});
 execFileSync(binary,[],{stdio:"inherit",timeout:20000});
} finally {rmSync(dir,{recursive:true,force:true});}
