import { expect, test, type Page } from '@playwright/test';

/**
 * 端到端主链路冒烟。
 *
 * 后端与大模型全部通过 page.route 打桩：E2E 只验证前端链路
 * （SSE 解码 -> Stream Adapter -> store -> 渲染），不依赖真实 API Key 与网络。
 */

function sseFrame(event: string, data: Record<string, unknown>, id: number) {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const ANSWER_TEXT = 'Agentic RAG 通过检索、精排和证据校验降低幻觉。';
const QUESTION_TEXT = 'Agentic RAG 如何降低幻觉？';
const PAPER_TITLE = 'Agentic Retrieval for Grounded Research Assistants';

async function mockKnowledgeApis(page: Page) {
  await page.route('**/api/knowledge', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          documents: [{ id: 'doc-1', name: 'agentic-rag.md', createdAt: 1_720_000_000_000, chunkCount: 3 }]
        })
      });
      return;
    }

    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
}

async function mockChatStream(page: Page) {
  await page.route('**/api/chat/stream', async (route) => {
    const body = [
      sseFrame('status', { stage: 'run_started', runId: 'run-e2e' }, 1),
      sseFrame('plan', { runId: 'run-e2e', intent: '直接回答科研问题', needsTools: false, steps: [] }, 2),
      sseFrame('delta', { text: ANSWER_TEXT }, 3),
      sseFrame('done', { reason: 'complete', runId: 'run-e2e' }, 4)
    ].join('');

    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      },
      body
    });
  });
}

/** 三步计划在第 1 步后命中终止条件，跳过第 2、3 步 */
async function mockStoppedEarlyStream(page: Page) {
  await page.route('**/api/chat/stream', async (route) => {
    const body = [
      sseFrame('status', { stage: 'run_started', runId: 'run-stop' }, 1),
      sseFrame(
        'plan',
        {
          runId: 'run-stop',
          intent: '检索知识库后按需补充文献',
          needsTools: true,
          stopWhen: '知识库已有足够证据',
          steps: [
            { step: 1, tool: 'retrieve_knowledge', reason: '先查本地知识库' },
            { step: 2, tool: 'search_literature', reason: '证据不足时补充文献' },
            { step: 3, tool: 'query_paper_memory', reason: '聚合已抽取的论文卡片' }
          ]
        },
        2
      ),
      sseFrame('status', { stage: 'executing', totalSteps: 3 }, 3),
      sseFrame(
        'status',
        { stage: 'plan_stopped_early', afterStep: 1, skippedSteps: [2, 3], stopWhen: '知识库已有足够证据' },
        4
      ),
      sseFrame('status', { stage: 'generating' }, 5),
      sseFrame('delta', { text: ANSWER_TEXT }, 6),
      sseFrame('done', { reason: 'complete', runId: 'run-stop' }, 7)
    ].join('');

    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache'
      },
      body
    });
  });
}

async function mockResearchApis(page: Page) {
  await page.route('**/api/research/search-literature', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            paperId: 'paper-1',
            source: 'openalex',
            title: PAPER_TITLE,
            abstract: 'A retrieval planner combines vector recall, reranking and groundedness checks.',
            authors: ['Li Wei', 'Chen Yu'],
            year: 2026,
            venue: 'Research AI',
            url: 'https://example.com/paper-1',
            pdfUrl: '',
            citationCount: 42,
            referenceCount: 18
          }
        ]
      })
    });
  });

  await page.route('**/api/research/paper-schema/extract', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        paperId: 'paper-1',
        schema: {
          title: PAPER_TITLE,
          problem: '科研问答需要可追溯证据。',
          method: 'Planner + Retriever + Verifier',
          architecture: 'Agentic RAG',
          dataset: ['ResearchQA'],
          metrics: ['Groundedness'],
          conclusion: '证据校验提升可靠性。',
          limitations: ['需要高质量语料']
        }
      })
    });
  });

  await page.route('**/api/research/gaps/mine', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        opportunities: [
          {
            opportunity: '补充跨领域 groundedness 评测',
            rationale: '现有验证集领域覆盖不足。',
            supportingPaperIds: ['paper-1'],
            confidence: 0.72
          }
        ]
      })
    });
  });

  await page.route('**/api/research/spec/generate', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        experimentSpec: {
          baseline: 'Vector RAG baseline',
          proposed_change: '加入 verifier 反馈回路',
          dataset: 'ResearchQA',
          metrics: ['Groundedness', 'Citation Precision'],
          training_plan: {
            epochs: 3,
            optimizer: 'AdamW',
            learning_rate: '2e-4',
            batch_size: 16,
            notes: '固定随机种子。'
          },
          ablation_plan: ['移除 verifier', '移除 reranker'],
          evidenceRefs: [{ paperId: 'paper-1', title: PAPER_TITLE, reason: '支持实验设计' }]
        }
      })
    });
  });
}

test.beforeEach(async ({ page }) => {
  await mockKnowledgeApis(page);
  await mockChatStream(page);
  await mockResearchApis(page);
});

test('对话主链路：发送问题后流式渲染出回答', async ({ page }) => {
  await page.goto('/');

  // 侧边栏与 TopBar 都有 research-agent 标题，用 level 区分侧边栏那个
  await expect(page.getByRole('heading', { name: 'research-agent', exact: true, level: 2 })).toBeVisible();
  await expect(page.getByText('今天想探索什么？')).toBeVisible();

  await page.getByPlaceholder(/问问 research-agent/).fill(QUESTION_TEXT);
  await page.getByRole('button', { name: '发送' }).click();

  // 打字机 + rAF 缓冲会分帧写回，等待最终文本完整出现
  await expect(page.getByText(ANSWER_TEXT)).toBeVisible();
  // 用户气泡与侧边栏历史标题都会带上问题原文，分别断言避免 strict mode 冲突
  await expect(page.locator('.message-user').getByText(QUESTION_TEXT)).toBeVisible();
  await expect(page.locator('.history-item-title').getByText(QUESTION_TEXT)).toBeVisible();
});

test('知识库主链路：检索文献并产出 Schema / Gap / Spec', async ({ page }) => {
  await page.goto('/knowledge-base');

  await expect(page.getByRole('heading', { name: '我的知识库' })).toBeVisible();
  await expect(page.getByText('agentic-rag.md')).toBeVisible();

  await page.getByPlaceholder(/输入研究主题/).fill('agentic rag groundedness');
  await page.getByRole('button', { name: '检索文献' }).click();
  await expect(page.getByText(PAPER_TITLE).first()).toBeVisible();

  await page.getByRole('button', { name: '抽取 Schema' }).click();
  await expect(page.getByText('最新 Paper Schema')).toBeVisible();
  await expect(page.getByText(/Planner \+ Retriever \+ Verifier/)).toBeVisible();

  await page.getByRole('button', { name: '挖掘 Research Gap' }).click();
  await expect(page.getByText('补充跨领域 groundedness 评测')).toBeVisible();

  await page.getByRole('button', { name: '生成 Experiment Spec' }).click();
  await expect(page.getByText('Experiment Spec', { exact: true })).toBeVisible();
  await expect(page.getByText(/Vector RAG baseline/)).toBeVisible();
});

test('计划提前结束时时间线标出被跳过的步骤', async ({ page }) => {
  // 覆盖 beforeEach 里的默认对话打桩
  await mockStoppedEarlyStream(page);
  await page.goto('/');

  await page.getByPlaceholder(/问问 research-agent/).fill(QUESTION_TEXT);
  await page.getByRole('button', { name: '发送' }).click();

  await expect(page.getByText(ANSWER_TEXT)).toBeVisible();

  // 提前结束标签展示跳过的步数
  await expect(page.getByText('提前结束 · 跳过 2 步')).toBeVisible();

  // 第 1 步真的跑过，第 2、3 步被标记为已跳过
  const steps = page.locator('.el-step');
  await expect(steps).toHaveCount(3);
  await expect(steps.nth(0)).not.toHaveClass(/step-skipped/);
  await expect(steps.nth(1)).toHaveClass(/step-skipped/);
  await expect(steps.nth(2)).toHaveClass(/step-skipped/);
  // simple 模式只渲染 title，所以「已跳过」标在标题上
  await expect(page.getByText('search_literature（已跳过）')).toBeVisible();
  await expect(page.getByText('query_paper_memory（已跳过）')).toBeVisible();
  await expect(page.getByText('retrieve_knowledge', { exact: true })).toBeVisible();
});
