import { ref } from 'vue';
import { useChatStore } from '@/stores/chat';
import {
  extractPaperSchema,
  generateExperimentSpec,
  ingestLiteratureToKnowledge,
  mineResearchGaps,
  searchLiterature
} from '@/services/qwen';
import type { ExperimentSpec, LiteraturePaper, PaperSchema, ResearchGapOpportunity } from '@/types/chat';

/**
 * Research Brain 工作台的状态与动作。
 *
 * 从 KnowledgeBasePage 抽出来的原因：页面里五个动作的 try/busy/错误提示写法完全一样，
 * 集中到 runTask 里，组件只负责展示。
 */

const LITERATURE_PAGE_SIZE = 8;
const LITERATURE_SOURCE = 'all';

export function useResearchBrain(onDocumentsChanged?: () => Promise<void> | void) {
  const chatStore = useChatStore();

  const literatureQuery = ref('');
  const literatureResults = ref<LiteraturePaper[]>([]);
  const selectedPaperIds = ref<string[]>([]);
  const latestSchema = ref<PaperSchema | null>(null);
  const gaps = ref<ResearchGapOpportunity[]>([]);
  const experimentSpec = ref<ExperimentSpec | null>(null);
  const busy = ref(false);

  /** 统一处理 busy 开关、成功提示与错误落到 store */
  async function runTask(fallbackError: string, task: () => Promise<string>) {
    try {
      busy.value = true;
      chatStore.noticeMessage = await task();
    } catch (error) {
      chatStore.errorMessage = error instanceof Error ? error.message : fallbackError;
    } finally {
      busy.value = false;
    }
  }

  function searchPapers() {
    return runTask('文献检索失败', async () => {
      literatureResults.value = await searchLiterature(literatureQuery.value, LITERATURE_PAGE_SIZE, LITERATURE_SOURCE);
      selectedPaperIds.value = [];
      return `检索到 ${literatureResults.value.length} 篇文献。`;
    });
  }

  function ingestSelected() {
    return runTask('文献入库失败', async () => {
      const inserted = await ingestLiteratureToKnowledge(selectedPaperIds.value);
      await onDocumentsChanged?.();
      return `已导入 ${inserted.length} 篇文献到知识库。`;
    });
  }

  function extractSchema(paperId: string) {
    return runTask('Schema 抽取失败', async () => {
      latestSchema.value = await extractPaperSchema(paperId);
      return 'Paper Schema 抽取成功。';
    });
  }

  function mineGaps() {
    return runTask('Research Gap 挖掘失败', async () => {
      gaps.value = await mineResearchGaps(literatureQuery.value);
      return `已挖掘 ${gaps.value.length} 条研究机会。`;
    });
  }

  function generateSpec() {
    return runTask('Experiment Spec 生成失败', async () => {
      experimentSpec.value = await generateExperimentSpec(literatureQuery.value, 0);
      return 'Experiment Spec 生成成功。';
    });
  }

  return {
    literatureQuery,
    literatureResults,
    selectedPaperIds,
    latestSchema,
    gaps,
    experimentSpec,
    busy,
    searchPapers,
    ingestSelected,
    extractSchema,
    mineGaps,
    generateSpec
  };
}
