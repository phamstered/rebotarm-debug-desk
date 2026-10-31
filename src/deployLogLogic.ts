import { controlLogLines } from "./controlLogLogic";

export const DEPLOY_LOG_MAX_LINES = 2000;
export function appendDeployLog(previous: string[], output: string): string[] {
  return [...previous, ...controlLogLines(output).map((line) => line.slice(0, 4096))].slice(-DEPLOY_LOG_MAX_LINES);
}
