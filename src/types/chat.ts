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
