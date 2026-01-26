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


/**
 * Processa mensagem com AI e envia resposta
 * TODO: Migrar lógica completa do ai-agent-respond Edge Function
 */
export async function processAIMessage(options: ProcessMessageOptions) {
  const { threadId, organizationId, agentId, message, isBatched, messageCount } = options;

  console.log(`🤖 Processing message for thread ${threadId}`);
  if (isBatched) {
    console.log(`   Batched: ${messageCount} messages combined`);
  }

  try {
    // 1. Buscar configurações do agente e integração Claude
    const [agentResult, claudeIntegrationResult] = await Promise.all([
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
    ]);

    if (agentResult.error || !agentResult.data) {
      throw new Error('Agent not found');
    }

    const agent = agentResult.data;
    const claudeIntegration = claudeIntegrationResult.data;

    // 2. Usar API key da integração ou fallback para env
    const anthropicKey = (claudeIntegration?.config_values as any)?.api_key || process.env.ANTHROPIC_API_KEY;

    if (!anthropicKey) {
      throw new Error('Anthropic API key not configured for organization');
    }

    const anthropic = new Anthropic({ apiKey: anthropicKey });

    // 3. Buscar histórico de mensagens
    const { data: history } = await supabase
      .from('messages')
      .select('content, direction, sender_type')
      .eq('thread_id', threadId)
      .eq('organization_id', organizationId)
      .is('deleted_at', null)
      .order('created_at', { ascending: true })
      .limit(20);

    // 4. Montar mensagens para o Claude
    const messages: Anthropic.MessageParam[] = (history || [])
      .filter(m => m.content && m.content.trim() !== '')
      .map(m => ({
        role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
        content: m.content,
      }));

    // Adicionar mensagem atual (se não for vazia)
    if (message && message.trim() !== '') {
      messages.push({ role: 'user', content: message });
    }

    // Filtrar mensagens com conteúdo vazio
    const validMessages = messages.filter(m => {
      const content = typeof m.content === 'string' ? m.content : '';
      return content.trim() !== '';
    });

    if (validMessages.length === 0) {
      console.log('⚠️ No valid messages to process (all empty)');
      return { success: false, response: null };
    }

    // 5. TODO: Implementar RAG aqui
    // const knowledge = await searchRelevantKnowledge(message, organizationId);

    // 6. System prompt - sem botões de texto
    const systemPrompt = `${agent.system_prompt || 'Você é um assistente prestativo.'}

## TOM DE COMUNICAÇÃO
- Seja informal e natural, como uma conversa no WhatsApp
- Não use emojis excessivos
- Frases curtas e diretas

## REGRAS IMPORTANTES
❌ NUNCA use tags [BUTTONS], [OPTIONS] ou similares
❌ NUNCA formate opções como lista numerada (1. 2. 3.)
❌ NUNCA ofereça "escolha uma das opções abaixo" ou similares
✅ Responda de forma natural e fluída
✅ Se precisar dar opções, incorpore naturalmente no texto`;

    // 7. Chamar Claude
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: validMessages,
    });

    const aiResponse = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';

    console.log(`✅ AI response generated: "${aiResponse.substring(0, 100)}..."`);

    // 8. Enviar resposta (texto simples, sem botões)
    await sendWhatsAppMessage({
      threadId,
      organizationId,
      content: aiResponse,
    });

    return { success: true, response: aiResponse };

  } catch (error) {
    console.error('❌ AI processing error:', error);
    throw error;
  }
}
