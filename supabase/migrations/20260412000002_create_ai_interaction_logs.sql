-- Migration: Create ai_interaction_logs table for guardrails observability
-- Tracks every AI interaction with input/output guard results, metrics, and cost

CREATE TABLE IF NOT EXISTS ai_interaction_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES organizations(id),
  contact_id uuid REFERENCES contacts(id),
  thread_id uuid REFERENCES message_threads(id),

  -- Input
  user_message text NOT NULL,
  input_guard_result jsonb,
  detected_intent text,

  -- RAG
  rag_chunks_used jsonb,
  rag_query text,
  rag_products_detected text[],

  -- Generation (multi-provider)
  provider text,              -- anthropic | openai | google (from ai_agent config)
  generation_model text,      -- model chosen by client (e.g. claude-sonnet-4-6, gpt-4o)
  guard_model text,           -- guard model auto-selected per provider
  system_prompt_hash text,
  raw_response text,
  tools_used jsonb,
  tool_iterations integer,

  -- Output Guard
  output_guard_result jsonb,
  final_response text,
  was_rewritten boolean DEFAULT false,

  -- Metrics
  input_tokens integer,
  output_tokens integer,
  guard_input_tokens integer,
  guard_output_tokens integer,
  total_latency_ms integer,
  rag_latency_ms integer,
  input_guard_latency_ms integer,
  output_guard_latency_ms integer,
  generation_latency_ms integer,

  -- Cost tracking (informative — client's dashboard)
  estimated_cost_usd numeric(10,6),

  created_at timestamptz DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX idx_interaction_logs_org ON ai_interaction_logs(organization_id);
CREATE INDEX idx_interaction_logs_contact ON ai_interaction_logs(contact_id);
CREATE INDEX idx_interaction_logs_created ON ai_interaction_logs(created_at DESC);
CREATE INDEX idx_interaction_logs_intent ON ai_interaction_logs(detected_intent);
CREATE INDEX idx_interaction_logs_rewritten ON ai_interaction_logs(was_rewritten) WHERE was_rewritten = true;
CREATE INDEX idx_interaction_logs_provider ON ai_interaction_logs(provider);

-- RLS policies
ALTER TABLE ai_interaction_logs ENABLE ROW LEVEL SECURITY;

-- Service role has full access
CREATE POLICY "Service role full access on ai_interaction_logs"
  ON ai_interaction_logs
  FOR ALL
  USING (true)
  WITH CHECK (true);
