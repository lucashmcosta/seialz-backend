import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../lib/supabase.js';
import { sendWhatsAppMessage } from './whatsapp.js';

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
const AVAILABLE_TOOLS: Anthropic.Tool[] = [
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
    // 1. Buscar configuracoes do agente, integracao Claude, memorias e contato
    const [agentResult, claudeIntegrationResult, memoriesResult, contactResult] = await Promise.all([
      supabase
        .from('ai_agents')
        .select('*')
        .eq('id', agentId)
        .eq('organization_id', organizationId)
        .single(),
      supabase
        .from('organization_integrations')
        .select(`
          config_values,
          admin_integrations!inner(slug)
        `)
        .eq('organization_id', organizationId)
        .eq('admin_integrations.slug', 'claude-ai')
        .eq('is_enabled', true)
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
    const claudeIntegration = claudeIntegrationResult.data;
    const memories = memoriesResult.data as ContactMemories | null;
    const contact = contactResult.data;

    // 2. API key
    const anthropicKey = (claudeIntegration?.config_values as any)?.api_key || process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      throw new Error('Anthropic API key not configured');
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // 3. Buscar historico
    const { data: history } = await supabase
      .from('messages')
      .select('content, direction, sender_type')
      .eq('thread_id', threadId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(20);

    // 4. Montar mensagens
    const messages: Anthropic.MessageParam[] = (history || [])
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

    // 6. System prompt
    const systemPrompt = `${agent.system_prompt || 'Voce e um assistente prestativo.'}

## CONTEXTO DO CONTATO
- Nome atual: ${contact?.full_name || 'Nao informado'}
- Email: ${contact?.email || 'Nao informado'}
- Telefone: ${contact?.phone || 'Nao informado'}

## STATUS DO NOME DO CONTATO
${nameInstruction}

## TOM DE COMUNICACAO
- Seja informal e natural, como uma conversa no WhatsApp
- Nao use emojis excessivos
- Frases curtas e diretas

## REGRAS IMPORTANTES
NUNCA use tags [BUTTONS], [OPTIONS] ou similares
NUNCA formate opcoes como lista numerada (1. 2. 3.)
Responda de forma natural e fluida`;

    // 7. Chamar Claude
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: validMessages,
      tools: AVAILABLE_TOOLS,
    });

    // 8. Processar tool calls
    const toolsExecuted: string[] = [];
    let currentMessages = [...validMessages];
    let maxIterations = 5;
    let iterations = 0;

    while (response.stop_reason === 'tool_use' && iterations < maxIterations) {
      iterations++;
      console.log(`🔄 Tool iteration ${iterations}/${maxIterations}`);

      const toolUseBlocks = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
      );

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

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

      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: currentMessages,
        tools: AVAILABLE_TOOLS,
      });
    }

    // 9. Extrair resposta
    const textBlock = response.content.find(
      (block): block is Anthropic.TextBlock => block.type === 'text'
    );

    let aiResponse = textBlock?.text || '';

    // Fallback se vazio apos tools
    if (!aiResponse && toolsExecuted.length > 0) {
      console.log('⚠️ Empty response after tools, forcing text...');

      currentMessages.push({
        role: 'user',
        content: 'As ferramentas foram executadas. Agora responda ao cliente de forma natural.',
      });

      const retryResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: currentMessages,
      });

      const retryTextBlock = retryResponse.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      aiResponse = retryTextBlock?.text || '';
    }

    if (!aiResponse) {
      aiResponse = 'Desculpe, nao consegui processar sua mensagem. Pode repetir?';
    }

    console.log(`✅ AI response: "${aiResponse.substring(0, 100)}..."`);
    console.log(`   Tools: ${toolsExecuted.join(', ') || 'none'}`);

    // 10. Enviar resposta
    await sendWhatsAppMessage({
      threadId,
      organizationId,
      content: aiResponse,
    });

    return { success: true, response: aiResponse, toolsExecuted };

  } catch (error) {
    console.error('❌ AI processing error:', error);
    throw error;
  }
}
