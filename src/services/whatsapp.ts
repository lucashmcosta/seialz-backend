import twilio from 'twilio';
import { supabase, type QuickReplyButton } from '../lib/supabase.js';

interface SendMessageOptions {
  threadId: string;
  organizationId: string;
  content: string;
  buttons?: QuickReplyButton[];
}

/**
 * Envia mensagem pelo WhatsApp via Twilio
 */
export async function sendWhatsAppMessage(options: SendMessageOptions) {
  const { threadId, organizationId, content, buttons } = options;

  // 1. Buscar thread com org e contact (MULTI-TENANT)
  const { data: thread, error: threadError } = await supabase
    .from('message_threads')
    .select(`
      *,
      contacts!inner(phone),
      organizations!inner(
        twilio_account_sid,
        twilio_auth_token,
        whatsapp_phone_number
      )
    `)
    .eq('id', threadId)
    .eq('organization_id', organizationId)
    .single();

  if (threadError || !thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const org = thread.organizations as any;
  const customerPhone = (thread.contacts as any).phone;

  if (!org.twilio_account_sid || !org.twilio_auth_token) {
    throw new Error('Twilio credentials not configured for organization');
  }

  // 2. Formatar mensagem com botões (se houver)
  let messageBody = content;

  if (buttons && buttons.length > 0) {
    const buttonsText = buttons
      .map((b, i) => `${i + 1}. ${b.title}`)
      .join('\n');

    messageBody = `${content}\n\n${buttonsText}\n\n_Responda com o número da opção_`;

    // Salvar estado de botões
    await supabase
      .from('message_threads')
      .update({
        awaiting_button_response: true,
        button_options: buttons,
      })
      .eq('id', threadId)
      .eq('organization_id', organizationId);
  }

  // 3. Enviar via Twilio
  const twilioClient = twilio(org.twilio_account_sid, org.twilio_auth_token);

  const message = await twilioClient.messages.create({
    body: messageBody,
    from: `whatsapp:${org.whatsapp_phone_number}`,
    to: `whatsapp:${customerPhone}`,
  });

  console.log(`📤 Message sent: ${message.sid}`);

  // 4. Salvar mensagem no banco
  await supabase
    .from('messages')
    .insert({
      organization_id: organizationId,
      thread_id: threadId,
      direction: 'outbound',
      content: messageBody,
      sender_type: 'agent',
      whatsapp_message_sid: message.sid,
      whatsapp_status: 'sent',
      ai_processed: true,
      metadata: buttons ? { interactive: true, buttons } : {},
    });

  // 5. Esconder typing indicator
  await supabase
    .from('message_threads')
    .update({ 
      agent_typing: false, 
      agent_typing_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', threadId)
    .eq('organization_id', organizationId);

  return message;
}

/**
 * Mostra typing indicator
 */
export async function showTypingIndicator(threadId: string, organizationId: string) {
  await supabase
    .from('message_threads')
    .update({ 
      agent_typing: true, 
      agent_typing_at: new Date().toISOString() 
    })
    .eq('id', threadId)
    .eq('organization_id', organizationId);
}

/**
 * Esconde typing indicator
 */
export async function hideTypingIndicator(threadId: string, organizationId: string) {
  await supabase
    .from('message_threads')
    .update({ 
      agent_typing: false, 
      agent_typing_at: null 
    })
    .eq('id', threadId)
    .eq('organization_id', organizationId);
}
