import { supabase } from '../lib/supabase.js';
import { getModelCost } from '../guards/constants.js';
import type { InteractionLogEntry } from '../guards/types.js';

/**
 * Calculate estimated USD cost based on token counts and actual models used.
 * Looks up per-model pricing from the cost table.
 */
export function calculateEstimatedCost(
  generationModel: string,
  guardModel: string,
  inputTokens: number,
  outputTokens: number,
  guardInputTokens: number,
  guardOutputTokens: number
): number {
  const genCost = getModelCost(generationModel);
  const grdCost = getModelCost(guardModel);

  const generationCostUsd =
    (inputTokens * genCost.inputPerMTok + outputTokens * genCost.outputPerMTok) / 1_000_000;
  const guardCostUsd =
    (guardInputTokens * grdCost.inputPerMTok + guardOutputTokens * grdCost.outputPerMTok) / 1_000_000;

  return generationCostUsd + guardCostUsd;
}

/**
 * Simple hash of system prompt for tracking changes without storing full text.
 */
function hashPrompt(prompt: string): string {
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    const char = prompt.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return hash.toString(16);
}

/**
 * Logs a full AI interaction to ai_interaction_logs.
 * Fire-and-forget — errors are logged but never block the response.
 */
export async function logInteraction(entry: InteractionLogEntry, systemPrompt?: string): Promise<void> {
  try {
    const inputTokens = entry.input_tokens ?? 0;
    const outputTokens = entry.output_tokens ?? 0;
    const guardInputTokens = entry.guard_input_tokens ?? 0;
    const guardOutputTokens = entry.guard_output_tokens ?? 0;

    const estimatedCost = calculateEstimatedCost(
      entry.generation_model ?? '',
      entry.guard_model ?? '',
      inputTokens,
      outputTokens,
      guardInputTokens,
      guardOutputTokens
    );

    const row = {
      organization_id: entry.organization_id,
      contact_id: entry.contact_id,
      thread_id: entry.thread_id,

      user_message: entry.user_message,
      input_guard_result: entry.input_guard_result ?? null,
      detected_intent: entry.detected_intent ?? null,

      rag_chunks_used: entry.rag_chunks_used ?? null,
      rag_query: entry.rag_query ?? null,
      rag_products_detected: entry.rag_products_detected ?? null,

      provider: entry.provider ?? null,
      generation_model: entry.generation_model ?? null,
      guard_model: entry.guard_model ?? null,
      system_prompt_hash: systemPrompt ? hashPrompt(systemPrompt) : null,
      raw_response: entry.raw_response ?? null,
      tools_used: entry.tools_used ?? null,
      tool_iterations: entry.tool_iterations ?? null,

      output_guard_result: entry.output_guard_result ?? null,
      final_response: entry.final_response ?? null,
      was_rewritten: entry.was_rewritten ?? false,

      input_tokens: inputTokens || null,
      output_tokens: outputTokens || null,
      guard_input_tokens: guardInputTokens || null,
      guard_output_tokens: guardOutputTokens || null,
      total_latency_ms: entry.total_latency_ms ?? null,
      rag_latency_ms: entry.rag_latency_ms ?? null,
      input_guard_latency_ms: entry.input_guard_latency_ms ?? null,
      output_guard_latency_ms: entry.output_guard_latency_ms ?? null,
      generation_latency_ms: entry.generation_latency_ms ?? null,

      estimated_cost_usd: estimatedCost || null,
    };

    const { error } = await supabase.from('ai_interaction_logs').insert(row);

    if (error) {
      console.error('⚠️ Failed to log interaction:', error.message);
    }
  } catch (error) {
    console.error('⚠️ Error in logInteraction:', error instanceof Error ? error.message : error);
  }
}
