import {
  OUTPUT_GUARD_TIMEOUT_MS,
  UNGROUNDED_ESCALATION_RATIO,
  MAX_CHUNK_TOKENS_FOR_GUARD,
} from './constants.js';
import { OUTPUT_GUARD_PROMPT, buildOutputGuardMessages } from './prompts.js';
import type { GuardLLMClient } from './llm-client.js';
import type { OutputGuardResult, RAGChunkForGuard } from './types.js';

/**
 * Rough token estimation (~4 chars per token for Portuguese text).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Summarize chunks if they exceed the token budget.
 * Keeps title + first 500 chars of content per chunk.
 */
function prepareChunksForGuard(chunks: RAGChunkForGuard[]): string {
  const fullText = chunks
    .map(c => `[${c.title || 'Sem titulo'}]\n${c.content}`)
    .join('\n---\n');

  if (estimateTokens(fullText) <= MAX_CHUNK_TOKENS_FOR_GUARD) {
    return fullText;
  }

  // Truncate: title + first 500 chars per chunk
  return chunks
    .map(c => {
      const snippet = c.content.length > 500 ? c.content.substring(0, 500) + '...' : c.content;
      return `[${c.title || 'Sem titulo'}]\n${snippet}`;
    })
    .join('\n---\n');
}

/**
 * Parse JSON from LLM response, handling common formatting issues.
 */
function parseGuardJSON(text: string): OutputGuardResult | null {
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
 * Output Guard — Validates AI response against RAG chunks for grounding.
 *
 * Uses the organization's guard model with a timeout.
 * Falls back to 'send' on any error (fail-open).
 */
export async function guardOutput(
  response: string,
  ragChunks: RAGChunkForGuard[],
  userMessage: string,
  client: GuardLLMClient,
  guardModel: string
): Promise<{ result: OutputGuardResult; latencyMs: number; guardInputTokens: number; guardOutputTokens: number }> {
  const start = Date.now();
  let guardInputTokens = 0;
  let guardOutputTokens = 0;

  // If there are no RAG chunks, we can't verify grounding — pass through
  if (ragChunks.length === 0) {
    return {
      result: {
        action: 'send',
        groundedClaims: [],
        ungroundedClaims: [],
        confidence: 0.5,
      },
      latencyMs: Date.now() - start,
      guardInputTokens: 0,
      guardOutputTokens: 0,
    };
  }

  try {
    const chunksText = prepareChunksForGuard(ragChunks);
    const userContent = buildOutputGuardMessages(response, chunksText, userMessage);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), OUTPUT_GUARD_TIMEOUT_MS);

    try {
      const llmResponse = await client.complete({
        model: guardModel,
        systemPrompt: OUTPUT_GUARD_PROMPT,
        userMessage: userContent,
        maxTokens: 1024,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      guardInputTokens = llmResponse.inputTokens;
      guardOutputTokens = llmResponse.outputTokens;

      if (!llmResponse.text) {
        throw new Error('Empty response from output guard');
      }

      const parsed = parseGuardJSON(llmResponse.text);
      if (!parsed) {
        throw new Error(`Invalid guard response: ${llmResponse.text.substring(0, 100)}`);
      }

      // Validate and enforce escalation ratio
      const totalClaims = (parsed.groundedClaims?.length ?? 0) + (parsed.ungroundedClaims?.length ?? 0);
      if (totalClaims > 0 && (parsed.ungroundedClaims?.length ?? 0) / totalClaims > UNGROUNDED_ESCALATION_RATIO) {
        parsed.action = 'escalate';
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
      `⚠️ Output guard ${isTimeout ? 'timeout' : 'error'}: ${error instanceof Error ? error.message : 'unknown'}. Fail-open: sending original response.`
    );

    return {
      result: {
        action: 'send',
        groundedClaims: [],
        ungroundedClaims: [],
        confidence: 0,
      },
      latencyMs: Date.now() - start,
      guardInputTokens,
      guardOutputTokens,
    };
  }
}
