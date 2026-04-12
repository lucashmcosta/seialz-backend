import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import type { AIProvider } from '../lib/supabase.js';

// =============================================================================
// UNIFIED LLM CLIENT FOR GUARDS
// Provider-agnostic wrapper that normalizes guard calls across providers.
// =============================================================================

export interface GuardLLMResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface GuardLLMClient {
  /** The provider this client wraps */
  provider: AIProvider;
  /** Send a guard prompt and get a JSON text response */
  complete(options: {
    model: string;
    systemPrompt: string;
    userMessage: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<GuardLLMResponse>;
}

// =============================================================================
// ANTHROPIC
// =============================================================================

function createAnthropicGuardClient(apiKey: string): GuardLLMClient {
  const client = new Anthropic({ apiKey });

  return {
    provider: 'anthropic',
    async complete({ model, systemPrompt, userMessage, maxTokens, signal }) {
      const response = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        signal ? { signal } : undefined
      );

      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );

      return {
        text: textBlock?.text ?? '',
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}

// =============================================================================
// OPENAI
// =============================================================================

function createOpenAIGuardClient(apiKey: string): GuardLLMClient {
  const client = new OpenAI({ apiKey });

  return {
    provider: 'openai',
    async complete({ model, systemPrompt, userMessage, maxTokens, signal }) {
      const response = await client.chat.completions.create(
        {
          model,
          max_tokens: maxTokens,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
        },
        signal ? { signal } : undefined
      );

      return {
        text: response.choices?.[0]?.message?.content ?? '',
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
    },
  };
}

// =============================================================================
// GOOGLE GEMINI
// =============================================================================

function createGoogleGuardClient(apiKey: string): GuardLLMClient {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    provider: 'google',
    async complete({ model, systemPrompt, userMessage, maxTokens, signal }) {
      const generativeModel = genAI.getGenerativeModel({
        model,
        systemInstruction: systemPrompt,
        generationConfig: {
          maxOutputTokens: maxTokens,
          responseMimeType: 'application/json',
        },
      });

      const contentPromise = generativeModel.generateContent({
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      });

      // Google SDK doesn't support AbortSignal natively — race with abort
      let result;
      if (signal) {
        const abortPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            const err = new Error('Aborted'); err.name = 'AbortError'; reject(err);
          }
          signal.addEventListener('abort', () => {
            const err = new Error('Aborted'); err.name = 'AbortError'; reject(err);
          }, { once: true });
        });
        result = await Promise.race([contentPromise, abortPromise]);
      } else {
        result = await contentPromise;
      }

      const response = result.response;
      const text = response.text();
      const usage = response.usageMetadata;

      return {
        text,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      };
    },
  };
}

// =============================================================================
// FACTORY
// =============================================================================

export function createGuardClient(provider: AIProvider, apiKey: string): GuardLLMClient {
  switch (provider) {
    case 'anthropic':
      return createAnthropicGuardClient(apiKey);
    case 'openai':
      return createOpenAIGuardClient(apiKey);
    case 'google':
      return createGoogleGuardClient(apiKey);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
