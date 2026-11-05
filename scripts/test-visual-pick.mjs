import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
const dir=mkdtempSync(join(tmpdir(),"visual-pick-test-"));
try {
 const includes=["-Ibridge/easy_debug_bridge/include"];
 if(process.platform==="darwin" && existsSync("/opt/homebrew/include/boost/property_tree/ptree.hpp")) includes.push("-I/opt/homebrew/include");
 const binary=join(dir,"test");
 execFileSync("c++",["-std=c++17","-pthread","-Wall","-Wextra",...includes,"bridge/easy_debug_bridge/src/visual_pick.cpp","bridge/easy_debug_bridge/test/test_visual_pick.cpp","-o",binary],{stdio:"inherit"});
 execFileSync(binary,[],{stdio:"inherit",timeout:20000});
} finally {rmSync(dir,{recursive:true,force:true});}
