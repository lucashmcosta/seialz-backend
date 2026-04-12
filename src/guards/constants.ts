import type { AIProvider } from '../lib/supabase.js';

// =============================================================================
// GUARD CONSTANTS
// =============================================================================

// Guard model per provider — always the cheapest/fastest of the same provider
export const GUARD_MODELS: Record<AIProvider, string> = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  google: 'gemini-2.5-flash',
};

export function getGuardModel(provider: AIProvider): string {
  return GUARD_MODELS[provider];
}

// Timeouts
export const INPUT_GUARD_TIMEOUT_MS = 2000;
export const OUTPUT_GUARD_TIMEOUT_MS = 3000;

// =============================================================================
// COST PER MILLION TOKENS — per model
// Used for informative cost tracking (client's dashboard)
// =============================================================================

export interface ModelCost {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_COSTS: Record<string, ModelCost> = {
  // Anthropic
  'claude-sonnet-4-6':          { inputPerMTok: 3,    outputPerMTok: 15 },
  'claude-sonnet-4-20250514':   { inputPerMTok: 3,    outputPerMTok: 15 },
  'claude-haiku-4-5-20251001':  { inputPerMTok: 1,    outputPerMTok: 5 },
  // OpenAI
  'gpt-4o':                     { inputPerMTok: 2.5,  outputPerMTok: 10 },
  'gpt-4o-mini':                { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  // Google
  'gemini-2.5-pro':             { inputPerMTok: 1.25, outputPerMTok: 10 },
  'gemini-2.5-flash':           { inputPerMTok: 0.15, outputPerMTok: 0.6 },
};

/** Get cost rates for a model, with safe fallback */
export function getModelCost(model: string): ModelCost {
  return MODEL_COSTS[model] ?? { inputPerMTok: 0, outputPerMTok: 0 };
}

// Output guard thresholds
export const UNGROUNDED_ESCALATION_RATIO = 0.5; // >50% ungrounded → escalate
export const MAX_CHUNK_TOKENS_FOR_GUARD = 40_000; // Truncate chunks if exceeding this

// Regex pre-check patterns for prompt injection (fast, before LLM call)
export const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?|context)/i,
  /forget\s+(all\s+)?(your|previous|prior)\s+(instructions?|rules?|context|prompts?)/i,
  /disregard\s+(all\s+)?(previous|prior|above|earlier)/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /^system\s*:/im,
  /^(human|user|assistant)\s*:/im,
  /\bact\s+as\s+(if|though)\s+you\s+(are|were)\b/i,
  /\bnew\s+instructions?\s*:/i,
  /\boverride\s+(previous|all|system)\b/i,
  /\breset\s+(your|all)\s+(instructions?|rules?|context)\b/i,
  /\bdo\s+not\s+follow\s+(your|the|any)\s+(previous|original|initial)\b/i,
  /\bjailbreak\b/i,
  /\bDAN\s+mode\b/i,
  // Base64 encoded instruction attempts (common pattern: long base64 strings)
  /[A-Za-z0-9+/]{50,}={0,2}/,
];

// Quick regex to detect if message is likely just a name response
export const NAME_RESPONSE_PATTERNS: RegExp[] = [
  /^(me\s+chamo|meu\s+nome\s+(e|é)|sou\s+(o|a)\s+)/i,
  /^[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇÑ][a-záàâãéèêíïóôõöúçñ]+(\s+[A-ZÁÀÂÃÉÈÊÍÏÓÔÕÖÚÇÑ][a-záàâãéèêíïóôõöúçñ]+){0,3}$/,
];
