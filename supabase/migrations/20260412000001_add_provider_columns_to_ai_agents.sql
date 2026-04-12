-- Add multi-provider columns to ai_agents table
-- Supports: anthropic, openai, google

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS provider text DEFAULT 'anthropic';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS model text DEFAULT 'claude-sonnet-4-6';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS api_key text;

COMMENT ON COLUMN ai_agents.provider IS 'LLM provider: anthropic | openai | google';
COMMENT ON COLUMN ai_agents.model IS 'Model ID chosen by client (e.g. claude-sonnet-4-6, gpt-4o)';
COMMENT ON COLUMN ai_agents.api_key IS 'Client API key for the chosen provider';
