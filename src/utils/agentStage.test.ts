import { describe, it, expect } from 'vitest';
import { readStopEarly, resolveActiveStep, stageLabel } from './agentStage';

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

  it('提前结束时收口到 afterStep，被跳过的步骤不算完成', () => {
    expect(resolveActiveStep('generating', 4, 2)).toBe(2);
    expect(resolveActiveStep('done', 4, 1)).toBe(1);
  });

  it('afterStep 超出总步数时不越界', () => {
    expect(resolveActiveStep('done', 3, 9)).toBe(3);
  });

  it('afterStep 为 null / 0 时回退到按 stage 推断', () => {
    expect(resolveActiveStep('generating', 3, null)).toBe(3);
    expect(resolveActiveStep('executing', 3, 0)).toBe(1);
  });
});

describe('readStopEarly', () => {
  it('解析完整的 detail', () => {
    expect(readStopEarly({ afterStep: 2, skippedSteps: [3, 4], stopWhen: '已拿到足够证据' })).toEqual({
      afterStep: 2,
      skippedSteps: [3, 4],
      stopWhen: '已拿到足够证据'
    });
  });

  it('缺少 stopWhen 时降级为空串', () => {
    expect(readStopEarly({ afterStep: 1, skippedSteps: [2] })?.stopWhen).toBe('');
  });

  it('detail 缺失或字段不合法时返回 null', () => {
    expect(readStopEarly(undefined)).toBeNull();
    expect(readStopEarly({})).toBeNull();
    expect(readStopEarly({ afterStep: '2', skippedSteps: [3] })).toBeNull();
    expect(readStopEarly({ afterStep: 2, skippedSteps: [] })).toBeNull();
    expect(readStopEarly({ afterStep: 2 })).toBeNull();
  });

  it('过滤掉 skippedSteps 里的非数字项', () => {
    expect(readStopEarly({ afterStep: 1, skippedSteps: [2, 'x', null, 3] })?.skippedSteps).toEqual([2, 3]);
  });
});
