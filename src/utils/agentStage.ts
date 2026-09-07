/**
 * Agent 运行阶段的展示辅助。
 *
 * 服务端 status 事件里的 stage 是英文枚举，这里统一翻译成界面文案，
 * 并把阶段映射成 el-steps 的进度下标（Planner 出的步骤是否已经跑完只能从阶段推断）。
 */

import type { PlanStopEarly } from '@/types/chat';

/** stage -> 界面文案；未收录的阶段直接原样展示 */
export const STAGE_LABELS: Record<string, string> = {
  run_started: '启动运行',
  context: '整理上下文',
  planning: '规划中',
  executing: '执行工具',
  plan_stopped_early: '提前结束',
  generating: '生成答案',
  verifying: '校验证据',
  supplementing: '补充检索',
  done: '已完成'
};

/** 已经越过工具执行阶段，说明计划中的步骤都跑完了 */
const STAGES_AFTER_EXECUTION = new Set(['generating', 'verifying', 'supplementing', 'done']);

export function stageLabel(stage: string): string {
  if (!stage) return '';
  return STAGE_LABELS[stage] ?? stage;
}

/**
 * el-steps 的 active 下标。
 *
 * 规划阶段还没开始执行 -> 0；执行阶段无法从 stage 判断跑到第几步，统一停在第 1 步；
 * 进入生成及之后的阶段 -> 全部完成。
 *
 * 命中终止条件提前结束时，只有 afterStep 之前的步骤真的跑过，
 * 后面的被跳过，不能标成 success，所以在这里收口到 afterStep。
 */
export function resolveActiveStep(stage: string, stepCount: number, stoppedAfterStep?: number | null): number {
  if (stepCount <= 0) return 0;

  if (typeof stoppedAfterStep === 'number' && stoppedAfterStep > 0) {
    return Math.min(stoppedAfterStep, stepCount);
  }

  if (STAGES_AFTER_EXECUTION.has(stage)) return stepCount;
  if (stage === 'executing') return 1;
  return 0;
}

/**
 * 从 status 事件的 detail 里解析提前结束信息。
 *
 * detail 是后端透传的松散对象，这里做一次窄化，避免把 unknown 带进组件。
 * 字段不完整（缺 afterStep 或没有被跳过的步骤）时返回 null，不渲染该提示。
 */
export function readStopEarly(detail: Record<string, unknown> | undefined): PlanStopEarly | null {
  if (!detail) return null;

  const afterStep = detail.afterStep;
  if (typeof afterStep !== 'number' || !Number.isFinite(afterStep)) return null;

  const skippedSteps = Array.isArray(detail.skippedSteps)
    ? detail.skippedSteps.filter((step): step is number => typeof step === 'number')
    : [];
  if (!skippedSteps.length) return null;

  return {
    afterStep,
    skippedSteps,
    stopWhen: typeof detail.stopWhen === 'string' ? detail.stopWhen : ''
  };
}
