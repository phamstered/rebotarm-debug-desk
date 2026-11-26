import { beforeEach } from "vitest";
import { readTerminal } from "../terminalLogLogic";
let after = 0;
beforeEach(async () => { after = (await readTerminal(Number.MAX_SAFE_INTEGER)).latest; });
/** Assert diagnostics from this test only, at the actual shared output boundary. */
export async function terminalOutput(source?: string) {
  let cursor=after; const messages:string[]=[];
  for (;;) {
    const page=await readTerminal(cursor);
    messages.push(...page.entries.filter(e=>!source||e.source===source).map(e=>e.message));
    if(page.cursor>=page.latest||page.cursor===cursor)return messages.join("\n");
    cursor=page.cursor;
  }
}
