// src/services/whatsapp.ts

import twilio from 'twilio';
import { supabase, type QuickReplyButton } from '../lib/supabase.js';

interface WhatsAppConfig {
  account_sid: string;
  auth_token: string;
  messaging_service_sid?: string;
  whatsapp_number: string;
}

interface SendMessageOptions {
  threadId: string;
  organizationId: string;
  content: string;
  buttons?: QuickReplyButton[];
}

export async function sendWhatsAppMessage(options: SendMessageOptions) {
  const { threadId, organizationId, content, buttons } = options;

  // 1. Buscar thread e contato
  const { data: thread, error: threadError } = await supabase
    .from('message_threads')
    .select(`
      id,
      contact_id,
      contacts!inner(phone)
    `)
    .eq('id', threadId)
    .eq('organization_id', organizationId)
    .single();

  if (threadError || !thread) {
    throw new Error(`Thread not found: ${threadId}`);
  }

  const customerPhone = (thread.contacts as any).phone;

  // 2. Buscar configuração WhatsApp da org
  const { data: integration, error: integrationError } = await supabase
    .from('organization_integrations')
    .select(`
      config_values,
      admin_integrations!inner(slug)
    `)
    .eq('organization_id', organizationId)
    .eq('admin_integrations.slug', 'twilio-whatsapp')
    .eq('is_enabled', true)
    .single();

  if (integrationError || !integration) {
    throw new Error('WhatsApp integration not configured for organization');
  }

  const config = integration.config_values as WhatsAppConfig;

  if (!config.account_sid || !config.auth_token) {
    throw new Error('Twilio credentials not configured');
  }

  // 3. Formatar mensagem com botões (se houver)
  let messageBody = content;

  if (buttons && buttons.length > 0) {
    const buttonsText = buttons
      .map((b, i) => `${i + 1}. ${b.title}`)
      .join('\n');

    messageBody = `${content}\n\n${buttonsText}\n\n_Responda com o número da opção_`;

    await supabase
      .from('message_threads')
      .update({
        awaiting_button_response: true,
        button_options: buttons,
      })
      .eq('id', threadId)
      .eq('organization_id', organizationId);
  }

  // 4. Enviar via Twilio
  const twilioClient = twilio(config.account_sid, config.auth_token);

  const message = await twilioClient.messages.create({
    body: messageBody,
    from: `whatsapp:${config.whatsapp_number}`,
    to: `whatsapp:${customerPhone}`,
  });

  console.log(`📤 Message sent: ${message.sid}`);

  // 5. Salvar mensagem
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

  // 6. Esconder typing
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
