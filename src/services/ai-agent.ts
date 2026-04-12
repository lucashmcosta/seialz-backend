import { supabase } from '../lib/supabase.js';
import type { AIProvider } from '../lib/supabase.js';
import { sendWhatsAppMessage } from './whatsapp.js';
import { getRelevantContext, formatRAGContext, generateEmbedding, getOrganizationProducts, detectAllProductsInMessage, extractSearchContext, searchKnowledgeHybrid, rerankResults } from './rag.js';
import { guardInput } from '../guards/input-guard.js';
import { guardOutput } from '../guards/output-guard.js';
import { createGuardClient } from '../guards/llm-client.js';
import { createGenerationClient, type GenTool, type GenMessage, type GenContentBlock } from '../guards/generation-client.js';
import { logInteraction } from '../logging/interaction-logger.js';
import { getGuardModel } from '../guards/constants.js';
import type { OutputGuardResult, RAGChunkForGuard } from '../guards/types.js';

interface ProcessMessageOptions {
  threadId: string;
  organizationId: string;
  agentId: string;
  contactId: string;
  message: string;
  isBatched?: boolean;
  messageCount?: number;
}

interface ToolResult {
  success: boolean;
  message: string;
  data?: any;
}

interface ContactMemories {
  name_confirmed?: boolean;
  name_asked?: boolean;
  original_whatsapp_name?: string;
  facts?: string[];
  objections?: string[];
  qualification?: Record<string, any>;
}

// Available tools for the agent
const AVAILABLE_TOOLS: GenTool[] = [
  {
    name: "update_contact",
    description: `Atualiza informacoes do contato no CRM.

CONTEXTO IMPORTANTE:
O nome atual no sistema veio do perfil do WhatsApp e provavelmente NAO e o nome real do cliente.
Exemplos comuns: "g.s." (real: Gianluca Silveira), "Mae do Pedro" (real: Maria Santos)

REGRAS PARA NOME:
1. Use APENAS quando o cliente CONFIRMAR o nome real
2. O fluxo correto e:
   - Agente pergunta: "Posso confirmar seu nome completo para nosso cadastro?"
   - Cliente responde: "Gianluca Silveira" ou "Meu nome e Maria"
   - Agente confirma: "Perfeito, Gianluca!" e usa a tool
3. Marque name_was_confirmed: true ao usar

Para email, telefone e empresa: pode atualizar diretamente quando informado.`,
    input_schema: {
      type: "object" as const,
      properties: {
        full_name: {
          type: "string",
          description: "Nome completo REAL do contato (nao o nome do WhatsApp)"
        },
        first_name: { type: "string", description: "Primeiro nome real do contato" },
        last_name: { type: "string", description: "Sobrenome do contato" },
        email: { type: "string", description: "Email do contato" },
        phone: { type: "string", description: "Telefone do contato" },
        company_name: { type: "string", description: "Nome da empresa do contato" },
        name_was_confirmed: {
          type: "boolean",
          description: "OBRIGATORIO para nome. True = cliente informou/confirmou o nome real."
        }
      },
    },
  },
  {
    name: "mark_name_asked",
    description: `Marca que voce ja perguntou o nome do cliente nesta conversa.

USE ESTA TOOL IMEDIATAMENTE apos perguntar o nome para evitar perguntar novamente.
Exemplo de uso: Apos enviar "Posso confirmar seu nome completo?", chame esta tool.`,
    input_schema: {
      type: "object" as const,
      properties: {
        question_asked: {
          type: "string",
          description: "A pergunta que voce fez (ex: 'Perguntei nome completo para cadastro')"
        }
      },
    },
  },
  {
    name: "transfer_to_human",
    description: "Transfere a conversa para um atendente humano. Use quando o cliente pedir explicitamente, o assunto for muito complexo, ou houver reclamacao seria.",
    input_schema: {
      type: "object" as const,
      properties: {
        reason: { type: "string", description: "Motivo da transferencia para o atendente" },
      },
    },
  },
];

/**
 * Detecta se o nome parece ser um nome real ou um nome de perfil do WhatsApp
 */
function analyzeNameQuality(name: string | null): 'real' | 'suspicious' | 'unknown' {
  if (!name || name.trim() === '') return 'unknown';

  const trimmed = name.trim();

  // Padroes suspeitos (provavelmente nao e nome real)
  const suspiciousPatterns = [
    /^[a-z]\.[a-z]\.?$/i,           // "g.s.", "m.s."
    /^[a-z]{1,2}$/i,                // "gs", "ms"
    /^.{1,3}$/,                      // Muito curto (1-3 chars)
    /[✨🌟💫⭐️🔥💖]/,              // Emojis decorativos
    /^(mae|pai|tia|tio|vo)\s/i,     // "Mae do Pedro"
    /^\+?\d{10,}/,                   // Numero de telefone
    /^[^a-zA-Z\s]+$/,               // Sem letras
    /^(admin|user|cliente|test)/i,   // Nomes genericos
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(trimmed)) {
      return 'suspicious';
    }
  }

  // Parece um nome real se tem pelo menos 2 palavras e 5+ caracteres
  const words = trimmed.split(/\s+/);
  const firstWord = words[0] || '';

  if (words.length >= 2 && firstWord.length >= 3 && trimmed.length >= 5) {
    return 'real';
  }

  // Pode ser nome real incompleto (so primeiro nome)
  if (firstWord.length >= 3 && /^[a-zA-Z]+$/i.test(firstWord)) {
    return 'suspicious';
  }

  return 'unknown';
}

/**
 * Executa uma tool e retorna o resultado
 */
async function executeTool(
  toolName: string,
  args: any,
  context: { contactId: string; organizationId: string; threadId: string }
): Promise<ToolResult> {
  console.log(`🔧 Executing tool: ${toolName}`, args);

  try {
    switch (toolName) {
      case 'update_contact': {
        const updateData: Record<string, any> = {};

        // VALIDACAO: Nome so pode ser alterado com confirmacao
        if (args.full_name || args.first_name || args.last_name) {
          if (!args.name_was_confirmed) {
            console.log('❌ Name update rejected: no confirmation flag');
            return {
              success: false,
              message: 'ERRO: Para atualizar o nome, o cliente precisa ter confirmado. Use name_was_confirmed: true apenas quando o cliente informou o nome real.',
              data: { requires_confirmation: true }
            };
          }

          // Buscar nome atual para salvar como original
          const { data: currentContact } = await supabase
            .from('contacts')
            .select('full_name')
            .eq('id', context.contactId)
            .single();

          // Preparar dados do nome
          if (args.full_name) updateData.full_name = args.full_name;
          if (args.first_name) updateData.first_name = args.first_name;
          if (args.last_name) updateData.last_name = args.last_name;

          // Atualizar memorias
          const memoryUpdate: Record<string, any> = {
            name_confirmed: true,
            name_confirmed_at: new Date().toISOString(),
            name_asked: true,
            updated_at: new Date().toISOString(),
          };

          // Salvar nome original do WhatsApp
          const { data: existingMemory } = await supabase
            .from('contact_memories')
            .select('original_whatsapp_name')
            .eq('contact_id', context.contactId)
            .single();

          if (!existingMemory?.original_whatsapp_name && currentContact?.full_name) {
            memoryUpdate.original_whatsapp_name = currentContact.full_name;
          }

          await supabase
            .from('contact_memories')
            .upsert({
              organization_id: context.organizationId,
              contact_id: context.contactId,
              ...memoryUpdate,
            }, {
              onConflict: 'contact_id',
            });
        }

        // Outros campos nao precisam de confirmacao
        if (args.email) updateData.email = args.email;
        if (args.phone) updateData.phone = args.phone;
        if (args.company_name) updateData.company_name = args.company_name;

        if (Object.keys(updateData).length === 0) {
          return { success: false, message: 'Nenhum campo para atualizar' };
        }

        const { error } = await supabase
          .from('contacts')
          .update(updateData)
          .eq('id', context.contactId);

        if (error) {
          console.error('Error updating contact:', error);
          return { success: false, message: error.message };
        }

        console.log('✅ Contact updated:', updateData);
        return { success: true, message: 'Contato atualizado com sucesso', data: updateData };
      }

      case 'mark_name_asked': {
        const { error } = await supabase
          .from('contact_memories')
          .upsert({
            organization_id: context.organizationId,
            contact_id: context.contactId,
            name_asked: true,
            updated_at: new Date().toISOString(),
          }, {
            onConflict: 'contact_id',
          });

        if (error) {
          console.error('Error marking name asked:', error);
          return { success: false, message: error.message };
        }

        console.log('✅ Marked name as asked for contact:', context.contactId);
        return { success: true, message: 'Marcado que perguntou o nome' };
      }

      case 'transfer_to_human': {
        const { error } = await supabase
          .from('message_threads')
          .update({ needs_human_attention: true })
          .eq('id', context.threadId);

        if (error) {
          console.error('Error transferring to human:', error);
          return { success: false, message: error.message };
        }
        return { success: true, message: 'Conversa marcada para atencao humana' };
      }

      default:
        return { success: false, message: `Tool desconhecida: ${toolName}` };
    }
  } catch (error) {
    console.error(`Error executing tool ${toolName}:`, error);
    return { success: false, message: error instanceof Error ? error.message : 'Erro desconhecido' };
  }
}

/**
 * Constroi instrucao de nome baseada no estado
 */
function buildNameInstruction(
  contactName: string | null,
  memories: ContactMemories | null
): string {
  const nameQuality = analyzeNameQuality(contactName);
  const nameConfirmed = memories?.name_confirmed === true;
  const nameAsked = memories?.name_asked === true;

  if (nameConfirmed) {
    return `
NOME CONFIRMADO: "${contactName}"
   O cliente ja confirmou este nome. Nao pergunte novamente.
   Use o nome naturalmente na conversa.`;
  }

  if (nameAsked) {
    return `
AGUARDANDO CONFIRMACAO DE NOME
   Voce ja perguntou o nome do cliente nesta conversa.
   NAO pergunte novamente
   Aguarde o cliente responder ou continue a conversa normalmente
   Se o cliente informar o nome, use update_contact com name_was_confirmed: true`;
  }

  if (nameQuality === 'suspicious' || nameQuality === 'unknown') {
    return `
NOME PRECISA SER CONFIRMADO
   Nome atual: "${contactName || 'Nao informado'}"
   Este nome veio do WhatsApp e provavelmente NAO e o nome real.

   O QUE FAZER:
   1. Na sua PRIMEIRA resposta, inclua naturalmente uma pergunta sobre o nome
      Exemplos:
      - "Antes de continuar, posso confirmar seu nome completo para nosso cadastro?"
      - "Para te atender melhor, qual seu nome completo?"

   2. IMEDIATAMENTE apos perguntar, use a tool mark_name_asked

   3. Quando o cliente responder o nome, use update_contact com name_was_confirmed: true

   NAO use update_contact para nome sem o cliente ter informado
   NAO pergunte o nome mais de uma vez`;
  }

  return `
NOME PARECE CORRETO: "${contactName}"
   O nome parece ser real, mas nao foi confirmado pelo cliente.
   Voce pode usar o nome normalmente.
   Se o cliente corrigir o nome, use update_contact com name_was_confirmed: true.`;
}

/**
 * Processa mensagem com AI e envia resposta
 */
export async function processAIMessage(options: ProcessMessageOptions) {
  const { threadId, organizationId, agentId, contactId, message, isBatched, messageCount } = options;

  console.log(`🤖 Processing message for thread ${threadId}`);
  if (isBatched) {
    console.log(`   Batched: ${messageCount} messages combined`);
  }

  try {
    // 1. Buscar configuracoes do agente, memorias e contato
    const [agentResult, memoriesResult, contactResult] = await Promise.all([
      supabase
        .from('ai_agents')
        .select('*')
        .eq('id', agentId)
        .eq('organization_id', organizationId)
        .single(),
      supabase
        .from('contact_memories')
        .select('*')
        .eq('contact_id', contactId)
        .single(),
      supabase
        .from('contacts')
        .select('full_name, first_name, email, phone')
        .eq('id', contactId)
        .single(),
    ]);

    if (agentResult.error || !agentResult.data) {
      throw new Error('Agent not found');
    }

    const agent = agentResult.data;
    const memories = memoriesResult.data as ContactMemories | null;
    const contact = contactResult.data;

    // 2. Provider, model & API key — from the agent config (multi-tenant)
    const agentProvider: AIProvider = agent.provider || 'anthropic';
    const agentModel: string = agent.model || 'claude-sonnet-4-6';
    const apiKey: string = agent.api_key || '';
    if (!apiKey) {
      throw new Error(`API key not configured for agent (provider: ${agentProvider})`);
    }

    // Guard model: cheapest of the same provider
    const guardModel = getGuardModel(agentProvider);

    // Main generation client (provider-agnostic — supports tool use)
    const genClient = createGenerationClient(agentProvider, apiKey);

    // Guard client (provider-agnostic — cheapest model of same provider)
    const guardClient = createGuardClient(agentProvider, apiKey);

    // 3. Buscar historico
    const { data: history } = await supabase
      .from('messages')
      .select('content, direction, sender_type')
      .eq('thread_id', threadId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(20);

    // 4. Montar mensagens (provider-agnostic)
    const messages: GenMessage[] = (history || [])
      .filter(m => m.content && m.content.trim() !== '')
      .map(m => ({
        role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
        content: m.content,
      }));

    if (message && message.trim() !== '') {
      messages.push({ role: 'user', content: message });
    }

    const validMessages = messages.filter(m => {
      const content = typeof m.content === 'string' ? m.content : '';
      return content.trim() !== '';
    });

    if (validMessages.length === 0) {
      console.log('⚠️ No valid messages to process');
      return { success: false, response: null };
    }

    // 5. Construir instrucao de nome
    const nameInstruction = buildNameInstruction(contact?.full_name, memories);

    // === GUARDRAIL LAYER 1: INPUT GUARD + RAG PREP IN PARALLEL ===
    const messageHistoryForRAG = (history || []).map(m => ({
      content: m.content,
      direction: m.direction,
    }));
    const guardHistory = (history || [])
      .filter(m => m.content && m.content.trim() !== '')
      .slice(-6)
      .map(m => ({
        role: m.direction === 'inbound' ? 'user' : 'assistant',
        content: m.content,
      }));

    console.log('🛡️ Running input guard + RAG embedding in parallel...');
    const ragEmbeddingStart = Date.now();

    // Parallelism: input guard + embedding computation
    const searchContext = extractSearchContext(message, messageHistoryForRAG);
    const [inputGuardOutput, embedding, products] = await Promise.all([
      guardInput(message, guardHistory, guardClient, guardModel),
      generateEmbedding(searchContext),
      getOrganizationProducts(organizationId),
    ]);

    const { result: inputGuardResult, latencyMs: inputGuardLatencyMs } = inputGuardOutput;
    let totalGuardInputTokens = inputGuardOutput.guardInputTokens;
    let totalGuardOutputTokens = inputGuardOutput.guardOutputTokens;

    console.log(`🛡️ Input guard: action=${inputGuardResult.action} intent=${inputGuardResult.intent} confidence=${inputGuardResult.confidence} (${inputGuardLatencyMs}ms)`);

    // Metrics tracking
    let ragLatencyMs = 0;
    let generationLatencyMs = 0;
    let outputGuardLatencyMs = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let ragChunksForLog: Array<{ chunk_id?: string; title?: string; score?: number; rerank_score?: number }> = [];
    let ragProductsDetected: string[] = [];
    let rawResponse = '';
    let outputGuardResult: OutputGuardResult | null = null;
    let wasRewritten = false;

    // --- Handle block ---
    if (inputGuardResult.action === 'block') {
      console.log('🚫 Message blocked by input guard (prompt injection detected)');
      const blockedResponse = 'Desculpe, nao consegui entender sua mensagem. Pode reformular?';

      await sendWhatsAppMessage({ threadId, organizationId, content: blockedResponse });

      // Log and return
      logInteraction({
        organization_id: organizationId, contact_id: contactId, thread_id: threadId,
        user_message: message,
        input_guard_result: inputGuardResult,
        detected_intent: inputGuardResult.intent,
        provider: agentProvider, generation_model: agentModel, guard_model: guardModel,
        final_response: blockedResponse,
        guard_input_tokens: totalGuardInputTokens, guard_output_tokens: totalGuardOutputTokens,
        input_guard_latency_ms: inputGuardLatencyMs,
        total_latency_ms: Date.now() - ragEmbeddingStart,
      }).catch(() => {});

      return { success: true, response: blockedResponse, toolsExecuted: [] };
    }

    // --- Handle escalate (from input guard) ---
    if (inputGuardResult.action === 'escalate') {
      console.log('🚨 Escalating to human (input guard)');
      await executeTool('transfer_to_human', { reason: `Input guard escalation: ${inputGuardResult.reasoning}` }, { contactId, organizationId, threadId });
      const escalateResponse = 'Entendo sua preocupacao. Vou transferir voce para um de nossos atendentes que podera ajudar melhor. Um momento, por favor.';

      await sendWhatsAppMessage({ threadId, organizationId, content: escalateResponse });

      logInteraction({
        organization_id: organizationId, contact_id: contactId, thread_id: threadId,
        user_message: message,
        input_guard_result: inputGuardResult,
        detected_intent: inputGuardResult.intent,
        provider: agentProvider, generation_model: agentModel, guard_model: guardModel,
        final_response: escalateResponse,
        tools_used: ['transfer_to_human'],
        guard_input_tokens: totalGuardInputTokens, guard_output_tokens: totalGuardOutputTokens,
        input_guard_latency_ms: inputGuardLatencyMs,
        total_latency_ms: Date.now() - ragEmbeddingStart,
      }).catch(() => {});

      return { success: true, response: escalateResponse, toolsExecuted: ['transfer_to_human'] };
    }

    // --- RAG (skip or proceed) ---
    let ragContexts: Awaited<ReturnType<typeof getRelevantContext>> = [];
    let ragSection = '';

    // Acknowledgments in active conversations should NOT skip RAG —
    // the model needs product context to continue (e.g., "quero" after a price quote).
    // Only pure greetings/farewells/name responses truly skip RAG.
    const skipRag = inputGuardResult.action === 'skip_rag'
      && inputGuardResult.intent !== 'acknowledgment';

    if (skipRag) {
      console.log(`⏭️ Skipping RAG (intent: ${inputGuardResult.intent})`);
      ragLatencyMs = 0;
    } else {
      // action === 'proceed' — run RAG using the pre-computed embedding
      console.log('🔍 Running RAG with pre-computed embedding...');
      const ragStart = Date.now();

      if (embedding) {
        // Detect products
        const detectedProductIds = detectAllProductsInMessage(message, products);
        ragProductsDetected = detectedProductIds.map(id => {
          const p = products.find(prod => prod.id === id);
          return p?.name || id;
        });

        // If no product in current message, check recent history (last 10 msgs, both directions)
        let finalProductIds = detectedProductIds;
        if (finalProductIds.length === 0 && messageHistoryForRAG.length > 0) {
          const recentMessages = messageHistoryForRAG.slice(-10).reverse();
          for (const msg of recentMessages) {
            if (msg.content) {
              const detected = detectAllProductsInMessage(msg.content, products);
              if (detected.length > 0) {
                finalProductIds = detected;
                break;
              }
            }
          }
        }

        const { candidates, sourceStats } = await searchKnowledgeHybrid(embedding, organizationId, finalProductIds);

        if (candidates.length > 0) {
          const documents = candidates.map(c => c.content);
          const rerankedIndices = await rerankResults(searchContext, documents, 5);

          // Filter out low-relevance chunks (score < 0.30) to avoid polluting prompt
          const MIN_CHUNK_SCORE = 0.30;
          const filteredIndices = rerankedIndices.filter(idx => {
            const score = candidates[idx]?.similarity ?? 0;
            return score >= MIN_CHUNK_SCORE;
          });

          ragContexts = filteredIndices
            .map(idx => candidates[idx])
            .filter(Boolean)
            .map(chunk => ({
              content: chunk.content,
              title: chunk.title,
              scope: (chunk.scope || 'global') as 'product' | 'global',
              category: chunk.category || 'geral',
            }));

          ragChunksForLog = ragContexts.map((c, i) => ({
            title: c.title,
            score: candidates[filteredIndices[i]]?.similarity,
          }));

          if (filteredIndices.length < rerankedIndices.length) {
            console.log(`📚 RAG: filtered ${rerankedIndices.length - filteredIndices.length} low-score chunks (< ${MIN_CHUNK_SCORE})`);
          }
        }

        console.log(`📚 RAG: ${ragContexts.length} knowledge chunks injected`);
      } else {
        console.log('⚠️ RAG: Embedding failed, falling back to getRelevantContext');
        ragContexts = await getRelevantContext(message, organizationId, messageHistoryForRAG);
      }

      ragSection = formatRAGContext(ragContexts);
      ragLatencyMs = Date.now() - ragStart;
    }

    // 7. System prompt
    const systemPrompt = `${agent.custom_instructions || agent.system_prompt || 'Voce e um assistente prestativo.'}
${ragSection}

## CONTEXTO DO CONTATO
- Nome atual: ${contact?.full_name || 'Nao informado'}
- Email: ${contact?.email || 'Nao informado'}
- Telefone: ${contact?.phone || 'Nao informado'}

## STATUS DO NOME DO CONTATO
${nameInstruction}

## TOM DE COMUNICACAO
- Seja informal e natural, como uma conversa no WhatsApp
- NAO use emojis (exceto se o cliente usar primeiro)
- NAO use markdown (sem **negrito**, sem *italico*, sem listas com -)
- Frases curtas e diretas, texto puro
- Maximo 2 paragrafos curtos por mensagem

## REGRA CRITICA: MANTENHA O CONTEXTO
- Leia TODAS as mensagens anteriores da conversa
- Se o cliente ja disse qual produto quer, NAO pergunte de novo
- Se o cliente ja informou algo, NAO peca a mesma informacao
- Se o cliente reclamar que ja falou algo, peca desculpa e use a informacao que ele ja deu
- Quando o cliente disser "quero fechar" ou "quero pagar", avance direto para o fechamento

## REGRAS DE FORMATACAO
NUNCA use tags [BUTTONS], [OPTIONS] ou similares
NUNCA formate opcoes como lista numerada (1. 2. 3.)
NUNCA use markdown (**, *, -, #, etc) — WhatsApp nao renderiza
Responda de forma natural e fluida, texto corrido`;

    // 8. Chamar LLM (provider-agnostic)
    const generationStart = Date.now();
    let response = await genClient.generate({
      model: agentModel,
      maxTokens: 1024,
      system: systemPrompt,
      messages: validMessages,
      tools: AVAILABLE_TOOLS,
    });

    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;

    // 9. Processar tool calls (provider-agnostic loop)
    const toolsExecuted: string[] = [];
    let currentMessages: GenMessage[] = [...validMessages];
    let maxIterations = 5;
    let iterations = 0;

    while (response.stopReason === 'tool_use' && iterations < maxIterations) {
      iterations++;
      console.log(`🔄 Tool iteration ${iterations}/${maxIterations}`);

      const toolUseBlocks = response.content.filter(
        (block): block is GenContentBlock & { type: 'tool_use' } => block.type === 'tool_use'
      );

      const toolResults: GenContentBlock[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`🔧 Tool call: ${toolUse.name}`);
        toolsExecuted.push(toolUse.name);

        const result = await executeTool(
          toolUse.name,
          toolUse.input,
          { contactId, organizationId, threadId }
        );

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      currentMessages.push({ role: 'assistant', content: response.content });
      currentMessages.push({ role: 'user', content: toolResults });

      response = await genClient.generate({
        model: agentModel,
        maxTokens: 1024,
        system: systemPrompt,
        messages: currentMessages,
        tools: AVAILABLE_TOOLS,
      });

      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
    }

    // 10. Extrair resposta
    const textBlock = response.content.find(
      (block): block is GenContentBlock & { type: 'text' } => block.type === 'text'
    );

    let aiResponse = textBlock?.text || '';

    // Fallback se vazio apos tools
    if (!aiResponse && toolsExecuted.length > 0) {
      console.log('⚠️ Empty response after tools, forcing text...');

      currentMessages.push({
        role: 'user',
        content: 'As ferramentas foram executadas. Agora responda ao cliente de forma natural.',
      });

      const retryResponse = await genClient.generate({
        model: agentModel,
        maxTokens: 1024,
        system: systemPrompt,
        messages: currentMessages,
      });

      inputTokens += retryResponse.inputTokens;
      outputTokens += retryResponse.outputTokens;

      const retryTextBlock = retryResponse.content.find(
        (block): block is GenContentBlock & { type: 'text' } => block.type === 'text'
      );
      aiResponse = retryTextBlock?.text || '';
    }

    if (!aiResponse) {
      aiResponse = 'Desculpe, nao consegui processar sua mensagem. Pode repetir?';
    }

    rawResponse = aiResponse;
    generationLatencyMs = Date.now() - generationStart;

    console.log(`✅ AI response: "${aiResponse.substring(0, 100)}..."`);
    console.log(`   Tools: ${toolsExecuted.join(', ') || 'none'}`);

    // === GUARDRAIL LAYER 2: OUTPUT GUARD ===
    let finalResponse = aiResponse;

    if (ragContexts.length > 0) {
      console.log('🛡️ Running output guard...');
      const ragChunksForGuard: RAGChunkForGuard[] = ragContexts.map(c => ({
        title: c.title,
        content: c.content,
      }));

      const outputGuardOutput = await guardOutput(aiResponse, ragChunksForGuard, message, guardClient, guardModel);
      outputGuardResult = outputGuardOutput.result;
      outputGuardLatencyMs = outputGuardOutput.latencyMs;
      totalGuardInputTokens += outputGuardOutput.guardInputTokens;
      totalGuardOutputTokens += outputGuardOutput.guardOutputTokens;

      console.log(`🛡️ Output guard: action=${outputGuardResult.action} grounded=${outputGuardResult.groundedClaims.length} ungrounded=${outputGuardResult.ungroundedClaims.length} (${outputGuardLatencyMs}ms)`);

      if (outputGuardResult.action === 'rewrite' && outputGuardResult.rewrittenResponse) {
        console.log('✏️ Response rewritten by output guard');
        finalResponse = outputGuardResult.rewrittenResponse;
        wasRewritten = true;
      } else if (outputGuardResult.action === 'escalate') {
        console.log('🚨 Escalating to human (output guard — too many ungrounded claims)');
        await executeTool('transfer_to_human', { reason: 'Output guard escalation: majority of claims ungrounded' }, { contactId, organizationId, threadId });
        finalResponse = 'Vou verificar essas informacoes com nossa equipe para te dar uma resposta precisa. Um momento, por favor.';
        toolsExecuted.push('transfer_to_human');
        wasRewritten = true;
      }
    } else {
      console.log('⏭️ Skipping output guard (no RAG chunks to verify against)');
    }

    // 11. Enviar resposta
    await sendWhatsAppMessage({
      threadId,
      organizationId,
      content: finalResponse,
    });

    // === GUARDRAIL LAYER 3: LOGGING (fire-and-forget) ===
    const totalLatencyMs = Date.now() - ragEmbeddingStart;
    logInteraction({
      organization_id: organizationId,
      contact_id: contactId,
      thread_id: threadId,
      user_message: message,
      input_guard_result: inputGuardResult,
      detected_intent: inputGuardResult.intent,
      rag_chunks_used: ragChunksForLog.length > 0 ? ragChunksForLog : null,
      rag_query: ragContexts.length > 0 ? searchContext : null,
      rag_products_detected: ragProductsDetected.length > 0 ? ragProductsDetected : null,
      provider: agentProvider,
      generation_model: agentModel,
      guard_model: guardModel,
      raw_response: rawResponse,
      tools_used: toolsExecuted.length > 0 ? toolsExecuted : null,
      tool_iterations: iterations > 0 ? iterations : null,
      output_guard_result: outputGuardResult,
      final_response: finalResponse,
      was_rewritten: wasRewritten,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      guard_input_tokens: totalGuardInputTokens,
      guard_output_tokens: totalGuardOutputTokens,
      total_latency_ms: totalLatencyMs,
      rag_latency_ms: ragLatencyMs,
      input_guard_latency_ms: inputGuardLatencyMs,
      output_guard_latency_ms: outputGuardLatencyMs,
      generation_latency_ms: generationLatencyMs,
    }, systemPrompt).catch(() => {});

    return { success: true, response: finalResponse, toolsExecuted };

  } catch (error) {
    console.error('❌ AI processing error:', error);
    throw error;
  }
}
