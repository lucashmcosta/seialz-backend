// =============================================================================
// GUARD TYPES
// =============================================================================

export type InputIntent =
  | 'product_question'
  | 'objection'
  | 'greeting'
  | 'farewell'
  | 'complaint'
  | 'scheduling'
  | 'off_topic'
  | 'prompt_injection'
  | 'acknowledgment'
  | 'name_response';

export type InputGuardAction = 'proceed' | 'skip_rag' | 'block' | 'escalate';

export interface InputGuardResult {
  action: InputGuardAction;
  intent: InputIntent;
  confidence: number;
  reasoning: string;
}

export type OutputGuardAction = 'send' | 'rewrite' | 'escalate';

export interface OutputGuardResult {
  action: OutputGuardAction;
  groundedClaims: string[];
  ungroundedClaims: string[];
  rewrittenResponse?: string;
  confidence: number;
}

export interface RAGChunkForGuard {
  chunk_id?: string;
  title?: string;
  content: string;
  score?: number;
  rerank_score?: number;
}

export interface InteractionLogEntry {
  organization_id: string;
  contact_id: string;
  thread_id: string;

  // Input
  user_message: string;
  input_guard_result?: InputGuardResult | null;
  detected_intent?: string | null;

  // RAG
  rag_chunks_used?: Array<{ chunk_id?: string; title?: string; score?: number; rerank_score?: number }> | null;
  rag_query?: string | null;
  rag_products_detected?: string[] | null;

  // Generation
  provider?: string | null;
  generation_model?: string | null;
  guard_model?: string | null;
  system_prompt_hash?: string | null;
  raw_response?: string | null;
  tools_used?: string[] | null;
  tool_iterations?: number | null;

  // Output Guard
  output_guard_result?: OutputGuardResult | null;
  final_response?: string | null;
  was_rewritten?: boolean;

  // Metrics
  input_tokens?: number | null;
  output_tokens?: number | null;
  guard_input_tokens?: number | null;
  guard_output_tokens?: number | null;
  total_latency_ms?: number | null;
  rag_latency_ms?: number | null;
  input_guard_latency_ms?: number | null;
  output_guard_latency_ms?: number | null;
  generation_latency_ms?: number | null;

  // Cost
  estimated_cost_usd?: number | null;
}
