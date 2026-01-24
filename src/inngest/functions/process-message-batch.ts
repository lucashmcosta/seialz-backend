import { inngest } from '../../lib/inngest.js';
import { supabase, type QuickReplyButton } from '../../lib/supabase.js';
import { showTypingIndicator } from '../../services/whatsapp.js';
import { processAIMessage } from '../../services/ai-agent.js';

/**
 * Processa batch de mensagens com debounce de 5 segundos
 * 
 * Quando o cliente manda várias mensagens seguidas:
 * 1. Inngest agrupa pelo threadId
 * 2. Espera 5 segundos após a última mensagem
 * 3. Combina todas as mensagens
 * 4. Processa com AI
 */
export const processMessageBatch = inngest.createFunction(
  {
    id: 'process-message-batch',
    debounce: {
      key: 'event.data.threadId',
      period: '5s',
    },
    retries: 3,
  },
  { event: 'whatsapp/message.received' },
  async ({ event, step }) => {
    const { threadId, organizationId, contactId } = event.data;

    console.log(`🔄 Processing batch for thread: ${threadId}`);

    // 1. Validar que thread pertence à organização (MULTI-TENANT)
    const thread = await step.run('validate-thread', async () => {
      const { data, error } = await supabase
        .from('message_threads')
        .select('id, organization_id, contact_id, awaiting_button_response, button_options')
        .eq('id', threadId)
        .eq('organization_id', organizationId)
        .single();

      if (error || !data) {
        throw new Error(`Thread ${threadId} not found for org ${organizationId}`);
      }
      return data;
    });

    // 2. Mostrar typing indicator
    await step.run('show-typing', async () => {
      await showTypingIndicator(threadId, organizationId);
    });

    // 3. Buscar mensagens não processadas (MULTI-TENANT)
    const messages = await step.run('fetch-messages', async () => {
      const { data } = await supabase
        .from('messages')
        .select('id, content, media_type, media_urls')
        .eq('organization_id', organizationId)
        .eq('thread_id', threadId)
        .eq('direction', 'inbound')
        .eq('ai_processed', false)
        .is('deleted_at', null)
        .order('created_at', { ascending: true });
      return data || [];
    });

    if (messages.length === 0) {
      console.log('⚠️ No pending messages');
      await supabase
        .from('message_threads')
        .update({ agent_typing: false, agent_typing_at: null })
        .eq('id', threadId)
        .eq('organization_id', organizationId);
      return { processed: 0 };
    }

    console.log(`📨 Found ${messages.length} pending messages`);

    // 4. Processar resposta de botão (se aplicável)
    let combinedMessage = '';
    for (const msg of messages) {
      let content = msg.content || '';

      // Verificar se é resposta numérica de botão
      if (thread.awaiting_button_response && thread.button_options) {
        const optionNumber = parseInt(content.trim());
        const buttons = thread.button_options as QuickReplyButton[];

        if (optionNumber >= 1 && optionNumber <= buttons.length) {
          content = buttons[optionNumber - 1].title;
          console.log(`🔘 Button response: "${msg.content}" → "${content}"`);
        }
      }

      if (content) {
        combinedMessage += (combinedMessage ? '\n' : '') + content;
      }
    }

    // 5. Limpar estado de botões
    await step.run('clear-button-state', async () => {
      await supabase
        .from('message_threads')
        .update({
          awaiting_button_response: false,
          button_options: null,
        })
        .eq('id', threadId)
        .eq('organization_id', organizationId);
    });

    // 6. Buscar agente ativo
    const agent = await step.run('find-agent', async () => {
      const { data } = await supabase
        .from('ai_agents')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('is_enabled', true)
        .limit(1)
        .single();
      return data;
    });

    if (!agent) {
      console.log('⚠️ No active agent');
      await supabase
        .from('message_threads')
        .update({ agent_typing: false, agent_typing_at: null })
        .eq('id', threadId)
        .eq('organization_id', organizationId);
      return { processed: 0, reason: 'no_agent' };
    }

    // 7. Processar com AI
    await step.run('process-ai', async () => {
      await processAIMessage({
        threadId,
        organizationId,
        agentId: agent.id,
        contactId,
        message: combinedMessage,
        isBatched: messages.length > 1,
        messageCount: messages.length,
      });
    });

    // 8. Marcar mensagens como processadas
    await step.run('mark-processed', async () => {
      const messageIds = messages.map(m => m.id);
      await supabase
        .from('messages')
        .update({ ai_processed: true })
        .eq('organization_id', organizationId)
        .in('id', messageIds);
    });

    console.log(`✅ Batch processed: ${messages.length} messages`);

    return { processed: messages.length };
  }
);
