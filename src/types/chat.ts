export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type MessageStatus = 'idle' | 'streaming' | 'done' | 'error';
export type ToolStatus = 'pending' | 'running' | 'success' | 'error';

export interface Citation {
  id: string;
  title: string;
  snippet: string;
  source: string;
  score?: number;
}

export interface ToolInvocation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  status: MessageStatus;
  citations?: Citation[];
  tools?: ToolInvocation[];
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface KnowledgeDocument {
  id: string;
  name: string;
  createdAt: number;
  content?: string;
}

export interface AgentPlanStep {
  step: number;
  tool: string;
  reason?: string;
  optional?: boolean;
}

export interface AgentPlan {
  intent: string;
  steps: AgentPlanStep[];
}

/**
 * 计划提前结束的信息（服务端 plan_stopped_early 状态事件）。
 *
 * Executor 命中结构化终止条件时跳过剩余步骤，这里记录在第几步之后停下、
 * 跳过了哪些步骤，以及计划里对终止条件的自然语言描述。
 */
export interface PlanStopEarly {
  afterStep: number;
  skippedSteps: number[];
  stopWhen: string;
}

/** 答案的 groundedness 校验结果（Agentic RAG 动态验证的产物） */
export interface AnswerVerification {
  grounded: boolean;
  score: number;
  unsupported: string[];
  missingInfo: string;
  /** 无证据可校验时为 true，此时 grounded 不代表校验通过 */
  skipped?: boolean;
}

export interface BackendStreamEvent {
  type: 'token' | 'plan' | 'status' | 'tool' | 'citations' | 'done' | 'error';
  token?: string;
  citations?: Citation[];
  tool?: ToolInvocation;
  tools?: ToolInvocation[];
  message?: string;
  details?: string;
  code?: string;
  /** Agent Runtime 相关 */
  runId?: string;
  plan?: AgentPlan;
  stage?: string;
  detail?: Record<string, unknown>;
  verification?: AnswerVerification;
  reason?: 'complete' | 'interrupted' | 'aborted' | 'error';
}

export interface ApiErrorPayload {
  error: string;
  details?: string;
  code?: string;
}

export interface QwenMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ServerDocumentResponse {
  id: string;
  name: string;
  createdAt: number;
}

export interface LiteraturePaper {
  source: string;
  paperId: string;
  title: string;
  abstract: string;
  authors: string[];
  year: number | null;
  venue: string;
  url: string;
  pdfUrl: string;
  citationCount: number | null;
  referenceCount: number | null;
}

export interface PaperSchema {
  title: string;
  problem: string;
  method: string;
  architecture: string;
  dataset: string[];
  metrics: string[];
  conclusion: string;
  limitations: string[];
}

export interface ResearchGapOpportunity {
  opportunity: string;
  rationale: string;
  supportingPaperIds: string[];
  confidence: number;
}

export interface ExperimentSpec {
  baseline: string;
  proposed_change: string;
  dataset: string;
  metrics: string[];
  training_plan: {
    epochs: number;
    optimizer: string;
    learning_rate: string;
    batch_size: number;
    notes: string;
  };
  ablation_plan: string[];
  evidenceRefs: Array<{
    paperId: string;
    title: string;
    reason: string;
  }>;
}
