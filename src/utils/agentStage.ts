/**
 * Agent 运行阶段的展示辅助。
 *
 * 服务端 status 事件里的 stage 是英文枚举，这里统一翻译成界面文案，
 * 并把阶段映射成 el-steps 的进度下标（Planner 出的步骤是否已经跑完只能从阶段推断）。
 */

/** stage -> 界面文案；未收录的阶段直接原样展示 */
export const STAGE_LABELS: Record<string, string> = {
  run_started: '启动运行',
  context: '整理上下文',
  planning: '规划中',
  executing: '执行工具',
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
 */
export function resolveActiveStep(stage: string, stepCount: number): number {
  if (stepCount <= 0) return 0;
  if (STAGES_AFTER_EXECUTION.has(stage)) return stepCount;
  if (stage === 'executing') return 1;
  return 0;
}
