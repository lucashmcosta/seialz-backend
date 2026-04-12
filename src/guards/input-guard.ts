import {
  INPUT_GUARD_TIMEOUT_MS,
  INJECTION_PATTERNS,
  NAME_RESPONSE_PATTERNS,
} from './constants.js';
import { INPUT_GUARD_PROMPT, buildInputGuardMessages } from './prompts.js';
import type { GuardLLMClient } from './llm-client.js';
import type { InputGuardResult } from './types.js';

/**
 * Fast regex pre-check for obvious prompt injection patterns.
 * Runs BEFORE the LLM call to save latency/cost on obvious cases.
 */
function regexInjectionCheck(message: string): boolean {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }
  return false;
}

/**
 * Fast regex check for name responses.
 */
function regexNameCheck(message: string): boolean {
  const trimmed = message.trim();
  for (const pattern of NAME_RESPONSE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Parse JSON from LLM response, handling common formatting issues.
 */
function parseGuardJSON(text: string): InputGuardResult | null {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

/**
 * Input Guard — Classifies user message intent before RAG.
 *
 * Uses the organization's guard model with a timeout.
 * Falls back to 'proceed' on any error (fail-open).
 */
export async function guardInput(
  message: string,
  history: Array<{ role: string; content: string }>,
  client: GuardLLMClient,
  guardModel: string
): Promise<{ result: InputGuardResult; latencyMs: number; guardInputTokens: number; guardOutputTokens: number }> {
  const start = Date.now();
  let guardInputTokens = 0;
  let guardOutputTokens = 0;

  // --- Fast regex pre-checks ---

  // 1. Prompt injection regex (fastest path)
  if (regexInjectionCheck(message)) {
    return {
      result: {
        action: 'block',
        intent: 'prompt_injection',
        confidence: 0.95,
        reasoning: 'Detectado padrao de prompt injection via regex',
      },
      latencyMs: Date.now() - start,
      guardInputTokens: 0,
      guardOutputTokens: 0,
    };
  }

  // 2. Name response regex (fast skip_rag)
  if (regexNameCheck(message)) {
    return {
      result: {
        action: 'skip_rag',
        intent: 'name_response',
        confidence: 0.85,
        reasoning: 'Detectada resposta de nome via regex',
      },
      latencyMs: Date.now() - start,
      guardInputTokens: 0,
      guardOutputTokens: 0,
    };
  }

  // --- LLM classification ---
  try {
    const recentHistory = history
      .slice(-6)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const userContent = buildInputGuardMessages(message, recentHistory);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INPUT_GUARD_TIMEOUT_MS);

    try {
      const response = await client.complete({
        model: guardModel,
        systemPrompt: INPUT_GUARD_PROMPT,
        userMessage: userContent,
        maxTokens: 256,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      guardInputTokens = response.inputTokens;
      guardOutputTokens = response.outputTokens;

      if (!response.text) {
        throw new Error('Empty response from input guard');
      }

      const parsed = parseGuardJSON(response.text);
      if (!parsed || !parsed.action || !parsed.intent) {
        throw new Error(`Invalid guard response: ${response.text.substring(0, 100)}`);
      }

      // Enforce intent→action mapping (LLM sometimes returns wrong action for intent)
      const SKIP_RAG_INTENTS = ['greeting', 'farewell', 'acknowledgment', 'name_response'];
      if (SKIP_RAG_INTENTS.includes(parsed.intent) && parsed.action === 'proceed') {
        parsed.action = 'skip_rag';
      }
      if (parsed.intent === 'prompt_injection' && parsed.action !== 'block') {
        parsed.action = 'block';
      }

      return {
        result: parsed,
        latencyMs: Date.now() - start,
        guardInputTokens,
        guardOutputTokens,
      };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    console.warn(
      `⚠️ Input guard ${isTimeout ? 'timeout' : 'error'}: ${error instanceof Error ? error.message : 'unknown'}. Falling back to proceed.`
    );

    return {
      result: {
        action: 'proceed',
        intent: 'product_question',
        confidence: 0,
        reasoning: isTimeout
          ? 'Timeout do input guard — fail-open para proceed'
          : `Erro no input guard: ${error instanceof Error ? error.message : 'unknown'} — fail-open`,
      },
      latencyMs: Date.now() - start,
      guardInputTokens,
      guardOutputTokens,
    };
  }
}
