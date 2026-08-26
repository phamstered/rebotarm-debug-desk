import { loadJq } from "jq-wasm/inline";

const jqEngine = loadJq();

export async function runJqFilter(input: unknown, expression: string): Promise<unknown[]> {
  const engine = await jqEngine;
  return engine.json(input as string | number | boolean | object | null, expression.trim() || ".");
}

export function formatJqOutputs(outputs: unknown[]): string {
  if (outputs.length === 0) return "（jq 没有输出）";
  return JSON.stringify(outputs.length === 1 ? outputs[0] : outputs, null, 2);
}
