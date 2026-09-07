<template>
  <section v-if="visible" class="agent-timeline">
    <div class="agent-timeline-head">
      <el-tag v-if="stage" type="primary" effect="light" round size="small">{{ stageLabel(stage) }}</el-tag>
      <span v-if="plan?.intent" class="agent-timeline-intent">{{ plan.intent }}</span>
      <el-tooltip v-if="verification" :content="verificationTooltip" placement="top">
        <el-tag :type="verificationTagType" effect="light" round size="small">{{ verificationLabel }}</el-tag>
      </el-tooltip>
      <el-tooltip v-if="stopEarly" :content="stopEarlyTooltip" placement="top">
        <el-tag type="warning" effect="light" round size="small">
          提前结束 · 跳过 {{ stopEarly.skippedSteps.length }} 步
        </el-tag>
      </el-tooltip>
    </div>

    <el-steps v-if="plan?.steps?.length" :active="activeStep" align-center finish-status="success" simple>
      <el-step
        v-for="step in plan.steps"
        :key="step.step"
        :class="{ 'step-skipped': skippedSteps.has(step.step) }"
        :title="stepTitle(step)"
        :description="step.optional ? `${step.reason ?? ''}（可选）` : step.reason"
      />
    </el-steps>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { resolveActiveStep, stageLabel } from '@/utils/agentStage';
import type { AgentPlan, AgentPlanStep, AnswerVerification, PlanStopEarly } from '@/types/chat';

const props = defineProps<{
  stage: string;
  plan: AgentPlan | null;
  verification: AnswerVerification | null;
  stopEarly: PlanStopEarly | null;
}>();

const visible = computed(() =>
  Boolean(props.stage || props.plan?.steps?.length || props.verification || props.stopEarly)
);
const activeStep = computed(() =>
  resolveActiveStep(props.stage, props.plan?.steps?.length ?? 0, props.stopEarly?.afterStep ?? null)
);

const skippedSteps = computed(() => new Set(props.stopEarly?.skippedSteps ?? []));

/**
 * 被跳过的步骤在标题上标注。
 * el-steps 的 simple 模式不渲染 description，所以标记必须放在 title 上才可见。
 */
function stepTitle(step: AgentPlanStep): string {
  return skippedSteps.value.has(step.step) ? `${step.tool}（已跳过）` : step.tool;
}

const stopEarlyTooltip = computed(() => {
  const stopEarly = props.stopEarly;
  if (!stopEarly) return '';
  const skipped = stopEarly.skippedSteps.join('、');
  const reason = stopEarly.stopWhen ? `终止条件：${stopEarly.stopWhen}` : '已满足计划里的终止条件';
  return `第 ${stopEarly.afterStep} 步后${reason}，跳过第 ${skipped} 步`;
});

const verificationLabel = computed(() => {
  const verification = props.verification;
  if (!verification) return '';
  if (verification.skipped) return '未校验';
  return verification.grounded
    ? `证据充分 ${verification.score.toFixed(2)}`
    : `证据不足 ${verification.score.toFixed(2)}`;
});

const verificationTagType = computed(() => {
  const verification = props.verification;
  if (!verification || verification.skipped) return 'info';
  return verification.grounded ? 'success' : 'warning';
});

const verificationTooltip = computed(() => {
  const verification = props.verification;
  if (!verification) return '';
  if (verification.skipped) return '本轮没有检索证据，跳过 groundedness 校验';
  if (verification.missingInfo) return `缺失信息：${verification.missingInfo}`;
  if (verification.unsupported.length) return `缺少支撑的表述：${verification.unsupported.join('；')}`;
  return '回答中的关键表述都能在检索证据里找到出处';
});
</script>

<style scoped>
.agent-timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--panel-line);
  background: var(--panel-muted);
}

.agent-timeline-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.agent-timeline-intent {
  font-size: 13px;
  color: var(--muted);
}

/* 被跳过的步骤压低视觉权重，和真正跑过的步骤区分开 */
.step-skipped {
  opacity: 0.55;
}
</style>
