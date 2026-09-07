import { describe, it, expect, vi } from 'vitest';
import {
  createPlan,
  createDirectAnswerPlan,
  extractJsonObject,
  normalizeStopConditions,
  planSchema,
  TOOL_CATALOG
} from './planner.js';
import { createCancelRoot, CancelReason, CancelledError } from './cancelTree.js';

/** 构造一个模拟 qwenFetch，返回指定的模型输出 */
function mockQwen(content) {
  return vi.fn(async () => ({ choices: [{ message: { content } }] }));
}

describe('extractJsonObject', () => {
  it('解析裸 JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥掉 ```json 代码块', () => {
    expect(extractJsonObject('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('剥掉无语言标记的代码块', () => {
    expect(extractJsonObject('```\n{"a":3}\n```')).toEqual({ a: 3 });
  });

  it('容忍 JSON 前后的解释文字', () => {
    expect(extractJsonObject('好的，计划如下：{"a":4} 以上。')).toEqual({ a: 4 });
  });

  it('空输入报 PLAN_EMPTY', () => {
    expect(() => extractJsonObject('')).toThrowError(/PLAN_EMPTY|返回为空/);
  });

  it('无 JSON 对象报 PLAN_PARSE_ERROR', () => {
    expect(() => extractJsonObject('完全没有 json')).toThrowError(/不含 JSON/);
  });

  it('非法 JSON 报 PLAN_PARSE_ERROR', () => {
    expect(() => extractJsonObject('{broken:')).toThrowError(/不合法|不含 JSON/);
  });
});

describe('planSchema 校验', () => {
  it('接受合法计划', () => {
    const result = planSchema.safeParse({
      needsTools: true,
      intent: '查文献',
      steps: [{ step: 1, tool: 'search_literature', args: { query: 'x' }, reason: '需要最新进展' }],
      stopWhen: '拿到 5 篇'
    });
    expect(result.success).toBe(true);
  });

  it('拒绝不在目录里的工具名', () => {
    const result = planSchema.safeParse({
      needsTools: true,
      steps: [{ step: 1, tool: 'rm_rf_slash', args: {}, reason: 'x' }]
    });
    expect(result.success).toBe(false);
  });

  it('args 缺省时补空对象', () => {
    const result = planSchema.safeParse({
      needsTools: true,
      steps: [{ step: 1, tool: 'get_current_time', reason: '要时间' }]
    });
    expect(result.success).toBe(true);
    expect(result.data.steps[0].args).toEqual({});
  });

  it('optional 缺省为 false', () => {
    const result = planSchema.safeParse({
      needsTools: true,
      steps: [{ step: 1, tool: 'get_current_time', reason: 'x' }]
    });
    expect(result.data.steps[0].optional).toBe(false);
  });

  it('reason 为空时校验失败', () => {
    const result = planSchema.safeParse({
      needsTools: true,
      steps: [{ step: 1, tool: 'get_current_time', args: {}, reason: '' }]
    });
    expect(result.success).toBe(false);
  });
});

describe('createPlan', () => {
  it('正常产出多步计划', async () => {
    const qwenFetch = mockQwen(
      JSON.stringify({
        needsTools: true,
        intent: '了解遥感分割最新进展',
        steps: [
          { step: 1, tool: 'retrieve_knowledge', args: { query: '遥感分割' }, reason: '先查个人知识库' },
          {
            step: 2,
            tool: 'search_literature',
            args: { query: 'remote sensing segmentation', limit: 5 },
            reason: '补充最新文献'
          }
        ],
        stopWhen: '两个来源都查完'
      })
    );

    const plan = await createPlan({
      question: '遥感图像分割最近有什么进展？',
      cancelNode: createCancelRoot('run'),
      qwenFetch
    });

    expect(plan.needsTools).toBe(true);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].tool).toBe('retrieve_knowledge');
    expect(plan.intent).toContain('遥感');
  });

  it('闲聊场景产出 needsTools=false', async () => {
    const qwenFetch = mockQwen(JSON.stringify({ needsTools: false, intent: '闲聊', steps: [], stopWhen: '直接答' }));

    const plan = await createPlan({
      question: '你好',
      cancelNode: createCancelRoot('run'),
      qwenFetch
    });

    expect(plan.needsTools).toBe(false);
    expect(plan.steps).toHaveLength(0);
  });

  it('step 序号被归一化为连续递增', async () => {
    const qwenFetch = mockQwen(
      JSON.stringify({
        needsTools: true,
        steps: [
          { step: 5, tool: 'get_current_time', args: {}, reason: 'a' },
          { step: 9, tool: 'search_literature', args: {}, reason: 'b' }
        ]
      })
    );

    const plan = await createPlan({ question: 'q', cancelNode: createCancelRoot('r'), qwenFetch });
    expect(plan.steps.map((s) => s.step)).toEqual([1, 2]);
  });

  it('needsTools 与 steps 矛盾时以 steps 为准（有步骤）', async () => {
    const qwenFetch = mockQwen(
      JSON.stringify({
        needsTools: false,
        steps: [{ step: 1, tool: 'get_current_time', args: {}, reason: 'x' }]
      })
    );
    const plan = await createPlan({ question: 'q', cancelNode: createCancelRoot('r'), qwenFetch });
    expect(plan.needsTools).toBe(true);
  });

  it('needsTools 与 steps 矛盾时以 steps 为准（无步骤）', async () => {
    const qwenFetch = mockQwen(JSON.stringify({ needsTools: true, steps: [] }));
    const plan = await createPlan({ question: 'q', cancelNode: createCancelRoot('r'), qwenFetch });
    expect(plan.needsTools).toBe(false);
  });

  it('模型输出非法工具名时降级为直接回答', async () => {
    const qwenFetch = mockQwen(
      JSON.stringify({
        needsTools: true,
        steps: [{ step: 1, tool: 'drop_database', args: {}, reason: 'evil' }]
      })
    );

    const plan = await createPlan({ question: 'q', cancelNode: createCancelRoot('r'), qwenFetch });
    expect(plan.needsTools).toBe(false);
    expect(plan.steps).toHaveLength(0);
    expect(plan.intent).toContain('降级');
  });

  it('模型输出乱码时抛解析错误', async () => {
    const qwenFetch = mockQwen('这不是 json');
    await expect(createPlan({ question: 'q', cancelNode: createCancelRoot('r'), qwenFetch })).rejects.toThrowError(
      /不含 JSON/
    );
  });

  it('已取消时立刻抛 CancelledError，不调模型', async () => {
    const root = createCancelRoot('run');
    root.cancel(CancelReason.USER_ABORT);
    const qwenFetch = mockQwen('{}');

    await expect(createPlan({ question: 'q', cancelNode: root, qwenFetch })).rejects.toBeInstanceOf(CancelledError);

    expect(qwenFetch).not.toHaveBeenCalled();
  });

  it('把工具目录与上下文摘要都写进 prompt', async () => {
    const qwenFetch = mockQwen(JSON.stringify({ needsTools: false, steps: [] }));
    await createPlan({
      question: '我的问题',
      contextHint: '之前聊过 ViT',
      cancelNode: createCancelRoot('r'),
      qwenFetch
    });

    const body = qwenFetch.mock.calls[0][1];
    const userMessage = body.messages.find((m) => m.role === 'user').content;
    expect(userMessage).toContain('retrieve_knowledge');
    expect(userMessage).toContain('之前聊过 ViT');
    expect(userMessage).toContain('我的问题');
    // 规划要确定性，温度必须为 0
    expect(body.temperature).toBe(0);
  });
});

describe('createDirectAnswerPlan', () => {
  it('产出无工具计划', () => {
    const plan = createDirectAnswerPlan('测试');
    expect(plan.needsTools).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(plan.intent).toBe('测试');
    expect(plan.stopConditions).toEqual([]);
  });
});

describe('normalizeStopConditions', () => {
  it('丢弃永远触发不了的条件', () => {
    const conditions = [
      { afterStep: 1, path: 'step1.count', op: 'gte', value: 3 },
      // afterStep 等于总步数，后面已无步骤可跳过
      { afterStep: 2, path: 'step2.count', op: 'gte', value: 3 },
      // gte 缺 value 无法求值
      { afterStep: 1, path: 'step1.count', op: 'gte' }
    ];
    expect(normalizeStopConditions(conditions, 2)).toEqual([conditions[0]]);
  });

  it('无工具步骤时条件全部清空', () => {
    expect(normalizeStopConditions([{ path: 'step1.count', op: 'exists' }], 0)).toEqual([]);
  });

  it('afterStep 缺省的条件保留', () => {
    const conditions = [{ path: 'step1.citations', op: 'nonEmpty' }];
    expect(normalizeStopConditions(conditions, 3)).toEqual(conditions);
  });
});

describe('工具目录', () => {
  it('每个工具都有必要的元信息', () => {
    for (const tool of TOOL_CATALOG) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.whenToUse).toBeTruthy();
      expect(tool.args).toBeTypeOf('object');
    }
  });

  it('工具名唯一', () => {
    const names = TOOL_CATALOG.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('目录规模控制在 10 个以内以保证规划准确率', () => {
    expect(TOOL_CATALOG.length).toBeLessThanOrEqual(10);
  });
});
