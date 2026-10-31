import { workflowSteps, type ArmWorkflow } from "./armModeWorkflowLogic";

export function ArmModeWorkflow({ workflow }: { workflow: ArmWorkflow | null }) {
  if (!workflow) return null;
  const steps = workflowSteps(workflow.mode);
  const index = steps.findIndex((step) => step.id === workflow.stage);
  return <section className="arm-workflow" aria-label="控制器启动流程" aria-live="polite">
    <ol>{steps.map((step, i) => {
      const state = i < index || (workflow.stage === "ready" && !workflow.failed) ? "done" : i === index ? workflow.failed ? "failed" : "current" : "waiting";
      return <li key={step.id} data-state={state} aria-current={state === "current" || state === "failed" ? "step" : undefined}>
        <span>{state === "done" ? "✓" : state === "failed" ? "!" : i + 1}</span>{step.label}
      </li>;
    })}</ol>
    <p role={workflow.failed ? "alert" : undefined}>{workflow.message}</p>
  </section>;
}
