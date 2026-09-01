import { describe, it, expect } from 'vitest';
import { resolveActiveStep, stageLabel } from './agentStage';

describe('stageLabel', () => {
  it('已收录的阶段翻译成中文', () => {
    expect(stageLabel('planning')).toBe('规划中');
    expect(stageLabel('verifying')).toBe('校验证据');
  });

  it('未收录的阶段原样返回，空值返回空串', () => {
    expect(stageLabel('unknown_stage')).toBe('unknown_stage');
    expect(stageLabel('')).toBe('');
  });
});

describe('resolveActiveStep', () => {
  it('没有步骤时恒为 0', () => {
    expect(resolveActiveStep('executing', 0)).toBe(0);
  });

  it('规划阶段停在第一步之前', () => {
    expect(resolveActiveStep('planning', 3)).toBe(0);
    expect(resolveActiveStep('context', 3)).toBe(0);
  });

  it('执行阶段停在第 1 步（stage 无法反映具体步号）', () => {
    expect(resolveActiveStep('executing', 3)).toBe(1);
  });

  it('进入生成及之后的阶段视为全部完成', () => {
    expect(resolveActiveStep('generating', 3)).toBe(3);
    expect(resolveActiveStep('verifying', 3)).toBe(3);
    expect(resolveActiveStep('supplementing', 3)).toBe(3);
    expect(resolveActiveStep('done', 3)).toBe(3);
  });
});
