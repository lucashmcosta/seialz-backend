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

interface QuickReplyButton {
  id: string;
  title: string;
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
    // 1. Buscar configurações do agente e org
    const [agentResult, orgResult] = await Promise.all([
      supabase
        .from('ai_agents')
        .select('*')
        .eq('id', agentId)
        .eq('organization_id', organizationId)
        .single(),
      supabase
        .from('organizations')
        .select('anthropic_api_key, voyage_api_key, openai_api_key')
        .eq('id', organizationId)
        .single(),
    ]);

    if (agentResult.error || !agentResult.data) {
      throw new Error('Agent not found');
    }

    const agent = agentResult.data;
    const org = orgResult.data;

    // 2. Usar API key da organização ou fallback para env
    const anthropicKey = org?.anthropic_api_key || process.env.ANTHROPIC_API_KEY;
    
    if (!anthropicKey) {
      throw new Error('Anthropic API key not configured');
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
      .filter(m => m.content)
      .map(m => ({
        role: m.direction === 'inbound' ? 'user' as const : 'assistant' as const,
        content: m.content,
      }));

    // Adicionar mensagem atual
    messages.push({ role: 'user', content: message });

    // 5. TODO: Implementar RAG aqui
    // const knowledge = await searchRelevantKnowledge(message, organizationId);

    // 6. System prompt com instruções de botões
    const systemPrompt = `${agent.system_prompt || 'Você é um assistente prestativo.'}

## TOM DE COMUNICAÇÃO
- Seja informal e natural, como uma conversa no WhatsApp
- Não use emojis excessivos
- Não use listas com bullets ou números (exceto botões)
- Frases curtas e diretas

## BOTÕES DE RESPOSTA RÁPIDA
Quando fizer sentido, ofereça opções usando botões:

[BUTTONS]
- Opção 1
- Opção 2
- Opção 3
[/BUTTONS]

Máximo 3 botões, máximo 20 caracteres cada.
Use apenas quando facilitar a conversa.`;

    // 7. Chamar Claude
    const response = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    const aiResponse = response.content[0].type === 'text' 
      ? response.content[0].text 
      : '';

    console.log(`✅ AI response generated: "${aiResponse.substring(0, 100)}..."`);

    // 8. Parsear botões da resposta
    const { text, buttons } = parseButtonsFromResponse(aiResponse);

    // 9. Enviar resposta
    await sendWhatsAppMessage({
      threadId,
      organizationId,
      content: text,
      buttons: buttons || undefined,
    });

    return { success: true, response: text };

  } catch (error) {
    console.error('❌ AI processing error:', error);
    throw error;
  }
}

/**
 * Extrai botões da resposta do AI
 */
function parseButtonsFromResponse(response: string): {
  text: string;
  buttons: QuickReplyButton[] | null;
} {
  const buttonRegex = /\[BUTTONS\]([\s\S]*?)\[\/BUTTONS\]/;
  const match = response.match(buttonRegex);

  if (!match) {
    return { text: response, buttons: null };
  }

  const buttonSection = match[1];
  const buttons = buttonSection
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('-'))
    .map((line, index) => ({
      id: `btn_${index + 1}`,
      title: line.replace(/^-\s*/, '').slice(0, 20),
    }))
    .slice(0, 3);

  const text = response.replace(buttonRegex, '').trim();

  return {
    text,
    buttons: buttons.length > 0 ? buttons : null,
  };
}
