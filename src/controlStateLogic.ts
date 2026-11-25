import type { ManagerSnapshot } from './controllerManagerLogic';
import { controllerStatusFresh } from './controllersInfoLogic';
import type { NativeTaskSnapshot, RosControlStatus } from './types';

/** Physical output, remote transaction and Controller observations are independent.
 * An absent Manager never proves a remote transaction has finished. */
export function reconcileControlState(manager: ManagerSnapshot | null, fresh: boolean, ros: RosControlStatus | null) {
  if (!fresh || !manager) return { state: 'unknown', reason: '等待新鲜 Manager 状态', modeKnown: false } as const;
  const bridgeFresh = controllerStatusFresh(ros);
  const active = (rows: {name:string;state:string}[]) => rows.filter(c=>c.state==='active').map(c=>c.name).sort().join('\n');
  if (bridgeFresh && (!manager.available || manager.manager !== ros!.manager || active(manager.controllers) !== active(ros!.controllers))) {
    return { state: 'conflict', reason: 'Manager 与 Bridge 的 Controller 状态不一致，等待两侧重新核验', modeKnown: false } as const;
  }
  if (!manager.available) return { state: 'offline', reason: '', modeKnown: true } as const;
  if (!bridgeFresh) return { state: 'unknown', reason: 'Manager 在线，等待 Bridge 的新鲜 Controller 状态', modeKnown: false } as const;
  return { state: 'ready', reason: '', modeKnown: true } as const;
}

export function controlTaskReason(task: NativeTaskSnapshot | null) {
  if (!task) return '';
  const phase = {submitting:'正在提交',running:'正在执行',stopping:'等待停止确认',uncertain:'结果待核验'}[task.phase];
  return `已有共享控制任务尚未结束 · ${phase}；新操作暂不可用，管理状态仍可刷新`;
}
