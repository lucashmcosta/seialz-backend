import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenerativeAI, type FunctionDeclaration, SchemaType } from '@google/generative-ai';
import type { AIProvider } from '../lib/supabase.js';

// =============================================================================
// UNIFIED GENERATION CLIENT
// Provider-agnostic wrapper for the main generation call with tool use.
// =============================================================================

/** Provider-agnostic tool definition */
export interface GenTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

/** Provider-agnostic message */
export interface GenMessage {
  role: 'user' | 'assistant';
  content: string | GenContentBlock[];
}

export type GenContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface GenResponse {
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens';
  content: GenContentBlock[];
  inputTokens: number;
  outputTokens: number;
}

export interface GenerationClient {
  provider: AIProvider;
  generate(options: {
    model: string;
    maxTokens: number;
    system: string;
    messages: GenMessage[];
    tools?: GenTool[];
  }): Promise<GenResponse>;
}

// =============================================================================
// ANTHROPIC
// =============================================================================

function createAnthropicGenClient(apiKey: string): GenerationClient {
  const client = new Anthropic({ apiKey });

  return {
    provider: 'anthropic',
    async generate({ model, maxTokens, system, messages, tools }) {
      const anthropicMessages: Anthropic.MessageParam[] = messages.map(m => {
        if (typeof m.content === 'string') {
          return { role: m.role, content: m.content };
        }
        // Map GenContentBlock[] to Anthropic content blocks
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam> = m.content.map(block => {
          if (block.type === 'text') return { type: 'text' as const, text: block.text };
          if (block.type === 'tool_use') return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
          if (block.type === 'tool_result') return { type: 'tool_result' as const, tool_use_id: block.tool_use_id, content: block.content };
          return { type: 'text' as const, text: '' };
        });
        return { role: m.role, content: blocks };
      });

      const anthropicTools: Anthropic.Tool[] | undefined = tools?.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema,
      }));

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: anthropicMessages,
        ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
      });

      const content: GenContentBlock[] = response.content.map(block => {
        if (block.type === 'text') return { type: 'text' as const, text: block.text };
        if (block.type === 'tool_use') return { type: 'tool_use' as const, id: block.id, name: block.name, input: block.input };
        return { type: 'text' as const, text: '' };
      });

      const stopReason = response.stop_reason === 'tool_use' ? 'tool_use' as const
        : response.stop_reason === 'max_tokens' ? 'max_tokens' as const
        : 'end_turn' as const;

      return {
        stopReason,
        content,
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      };
    },
  };
}

// =============================================================================
// OPENAI
// =============================================================================

function createOpenAIGenClient(apiKey: string): GenerationClient {
  const client = new OpenAI({ apiKey });

  return {
    provider: 'openai',
    async generate({ model, maxTokens, system, messages, tools }) {
      const openaiMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: 'system', content: system },
      ];

      for (const m of messages) {
        if (typeof m.content === 'string') {
          openaiMessages.push({ role: m.role, content: m.content });
        } else {
          // Handle tool use/result blocks
          const textParts = m.content.filter(b => b.type === 'text').map(b => (b as { type: 'text'; text: string }).text).join('');
          const toolUseParts = m.content.filter(b => b.type === 'tool_use');
          const toolResultParts = m.content.filter(b => b.type === 'tool_result');

          if (m.role === 'assistant' && toolUseParts.length > 0) {
            openaiMessages.push({
              role: 'assistant',
              content: textParts || null,
              tool_calls: toolUseParts.map(t => ({
                id: (t as any).id,
                type: 'function' as const,
                function: {
                  name: (t as any).name,
                  arguments: JSON.stringify((t as any).input),
                },
              })),
            });
          } else if (m.role === 'user' && toolResultParts.length > 0) {
            for (const tr of toolResultParts) {
              openaiMessages.push({
                role: 'tool',
                tool_call_id: (tr as any).tool_use_id,
                content: (tr as any).content,
              });
            }
          } else if (textParts) {
            openaiMessages.push({ role: m.role, content: textParts });
          }
        }
      }

      const openaiTools: OpenAI.ChatCompletionTool[] | undefined = tools?.map(t => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));

      const response = await client.chat.completions.create({
        model,
        max_tokens: maxTokens,
        messages: openaiMessages,
        ...(openaiTools?.length ? { tools: openaiTools } : {}),
      });

      const choice = response.choices?.[0];
      const content: GenContentBlock[] = [];

      if (choice?.message?.content) {
        content.push({ type: 'text', text: choice.message.content });
      }
      if (choice?.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          if ('function' in tc) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input: JSON.parse(tc.function.arguments || '{}'),
            });
          }
        }
      }

      const stopReason = choice?.finish_reason === 'tool_calls' ? 'tool_use' as const
        : choice?.finish_reason === 'length' ? 'max_tokens' as const
        : 'end_turn' as const;

      return {
        stopReason,
        content,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      };
    },
  };
}

// =============================================================================
// GOOGLE GEMINI
// =============================================================================

function convertToGeminiSchema(properties: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(properties)) {
    const prop: any = { description: value.description || '' };
    if (value.type === 'string') prop.type = SchemaType.STRING;
    else if (value.type === 'boolean') prop.type = SchemaType.BOOLEAN;
    else if (value.type === 'number' || value.type === 'integer') prop.type = SchemaType.NUMBER;
    else prop.type = SchemaType.STRING;
    result[key] = prop;
  }
  return result;
}

function createGoogleGenClient(apiKey: string): GenerationClient {
  const genAI = new GoogleGenerativeAI(apiKey);

  return {
    provider: 'google',
    async generate({ model, maxTokens, system, messages, tools }) {
      const functionDeclarations: FunctionDeclaration[] | undefined = tools?.map(t => ({
        name: t.name,
        description: t.description,
        parameters: {
          type: SchemaType.OBJECT,
          properties: convertToGeminiSchema(t.input_schema.properties),
        },
      }));

      const generativeModel = genAI.getGenerativeModel({
        model,
        systemInstruction: system,
        generationConfig: { maxOutputTokens: maxTokens },
        ...(functionDeclarations?.length ? { tools: [{ functionDeclarations }] } : {}),
      });

      // Convert messages to Gemini format
      const geminiHistory: Array<{ role: 'user' | 'model'; parts: any[] }> = [];

      for (const m of messages) {
        const role = m.role === 'assistant' ? 'model' as const : 'user' as const;

        if (typeof m.content === 'string') {
          geminiHistory.push({ role, parts: [{ text: m.content }] });
        } else {
          const parts: any[] = [];
          for (const block of m.content) {
            if (block.type === 'text') {
              parts.push({ text: block.text });
            } else if (block.type === 'tool_use') {
              parts.push({
                functionCall: { name: block.name, args: block.input },
              });
            } else if (block.type === 'tool_result') {
              parts.push({
                functionResponse: {
                  name: 'tool_response',
                  response: JSON.parse(block.content),
                },
              });
            }
          }
          if (parts.length > 0) {
            geminiHistory.push({ role, parts });
          }
        }
      }

      // Gemini uses chat with history for multi-turn
      const lastMessage = geminiHistory.pop();
      const chat = generativeModel.startChat({
        history: geminiHistory,
      });

      const result = await chat.sendMessage(lastMessage?.parts ?? [{ text: '' }]);
      const response = result.response;
      const content: GenContentBlock[] = [];

      for (const candidate of response.candidates ?? []) {
        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            content.push({ type: 'text', text: part.text });
          }
          if (part.functionCall) {
            content.push({
              type: 'tool_use',
              id: `gemini_${Date.now()}_${part.functionCall.name}`,
              name: part.functionCall.name,
              input: part.functionCall.args ?? {},
            });
          }
        }
      }

      const hasFunctionCall = content.some(c => c.type === 'tool_use');
      const usage = response.usageMetadata;

      return {
        stopReason: hasFunctionCall ? 'tool_use' as const : 'end_turn' as const,
        content,
        inputTokens: usage?.promptTokenCount ?? 0,
        outputTokens: usage?.candidatesTokenCount ?? 0,
      };
    },
  };
}

// =============================================================================
// FACTORY
// =============================================================================

export function createGenerationClient(provider: AIProvider, apiKey: string): GenerationClient {
  switch (provider) {
    case 'anthropic':
      return createAnthropicGenClient(apiKey);
    case 'openai':
      return createOpenAIGenClient(apiKey);
    case 'google':
      return createGoogleGenClient(apiKey);
    default:
      throw new Error(`Unsupported provider for generation: ${provider}`);
  }
}
