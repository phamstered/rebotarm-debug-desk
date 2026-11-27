import { useTerminalMessage } from "./terminalLogLogic";
import { workflowSteps, type ArmWorkflow } from "./armModeWorkflowLogic";

export function ArmModeWorkflow({ workflow, logOnly = false }: { workflow: ArmWorkflow | null; logOnly?:boolean }) {
  useTerminalMessage("Controller",workflow?.message,workflow?.failed?"error":"info");
  if (logOnly || !workflow || (!workflow.running && !workflow.failed)) return null;
  const steps = workflowSteps(workflow.mode);
  const index = steps.findIndex((step) => step.id === workflow.stage);
  return <section className="arm-workflow" aria-label="控制器启动流程" aria-live="polite">
    <ol>{steps.map((step, i) => {
      const state = i < index || (workflow.stage === "ready" && !workflow.failed) ? "done" : i === index ? workflow.failed ? "failed" : "current" : "waiting";
      return <li key={step.id} data-state={state} aria-current={state === "current" || state === "failed" ? "step" : undefined}>
        <span>{state === "done" ? "✓" : state === "failed" ? "!" : i + 1}</span>{step.label}
      </li>;
    })}</ol>
    {workflow.failed && <p className="arm-workflow-failure" role="alert">控制操作失败，详细原因见底部 Terminal</p>}
  </section>;
}
