// src/services/whatsapp.ts

import twilio from 'twilio';
import type { Twilio } from 'twilio';
import { supabase } from '../lib/supabase.js';
import type {
  InteractiveMessage,
  WhatsAppMessageType,
  QuickReplyButton,
} from '../types/whatsapp-messages.js';
import { validateInteractiveMessage } from '../types/whatsapp-messages.js';
import {
  createContentTemplate,
  createQuickReplyTemplate,
  createListTemplate,
  createCTATemplate,
  createCardTemplate,
  createLocationTemplate,
  createLocationRequestTemplate,
} from './twilio-content.js';

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
  interactive?: InteractiveMessage;
}

interface SendMessageResult {
  messageSid: string;
  savedMessageId: string;
  status: 'sent' | 'failed';
  error?: string;
}

/**
 * Envia uma mensagem do WhatsApp
 * Suporta mensagens de texto simples, botões quick reply legados, e mensagens interativas completas
 */
export async function sendWhatsAppMessage(options: SendMessageOptions): Promise<SendMessageResult> {
  const { threadId, organizationId, content, buttons, interactive } = options;

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

  // 3. Criar cliente Twilio
  const twilioClient = twilio(config.account_sid, config.auth_token);
  const from = `whatsapp:${config.whatsapp_number}`;
  const to = `whatsapp:${customerPhone}`;

  let message;
  let messageBody = content;
  let messageType: WhatsAppMessageType = 'text';
  let mediaUrl: string | undefined;

  try {
    // Determinar tipo de mensagem e enviar
    if (interactive) {
      // Validar mensagem interativa
      const validation = validateInteractiveMessage(interactive);
      if (!validation.valid) {
        console.warn('⚠️ Interactive message validation warnings:', validation.errors);
      }

      messageType = interactive.type;
      messageBody = interactive.body;

      // Enviar mensagem interativa
      message = await sendInteractiveMessage(twilioClient, from, to, interactive);

      // Extrair URL de mídia se houver
      if (interactive.media?.url) {
        mediaUrl = interactive.media.url;
      }

      // Atualizar thread se for quick reply ou list (aguardando resposta)
      if (interactive.type === 'quick_reply' && interactive.quickReplyButtons) {
        await supabase
          .from('message_threads')
          .update({
            awaiting_button_response: true,
            button_options: interactive.quickReplyButtons,
          })
          .eq('id', threadId)
          .eq('organization_id', organizationId);
      } else if (interactive.type === 'list' && interactive.listSections) {
        const allRows = interactive.listSections.flatMap((s) =>
          s.rows.map((r) => ({ id: r.id, title: r.title }))
        );
        await supabase
          .from('message_threads')
          .update({
            awaiting_button_response: true,
            button_options: allRows,
          })
          .eq('id', threadId)
          .eq('organization_id', organizationId);
      }
    } else if (buttons && buttons.length > 0) {
      // Converter botões legados para interactive e usar template
      const interactiveFromButtons: InteractiveMessage = {
        type: 'quick_reply',
        body: content,
        quickReplyButtons: buttons,
      };

      message = await sendInteractiveMessage(twilioClient, from, to, interactiveFromButtons);
      messageBody = content;
      messageType = 'quick_reply';

      await supabase
        .from('message_threads')
        .update({
          awaiting_button_response: true,
          button_options: buttons,
        })
        .eq('id', threadId)
        .eq('organization_id', organizationId);
    } else {
      // Mensagem de texto simples
      message = await twilioClient.messages.create({
        body: content,
        from,
        to,
      });
    }

    console.log(`📤 Message sent to Twilio: ${message.sid}`);

    // 5. Salvar mensagem
    console.log(`💾 Saving outbound message...`);
    const { data: savedMsg, error: saveError } = await supabase
      .from('messages')
      .insert({
        organization_id: organizationId,
        thread_id: threadId,
        direction: 'outbound',
        content: messageBody,
        sender_type: 'agent',
        whatsapp_message_sid: message.sid,
        whatsapp_status: 'sending',
        ai_processed: true,
        media_type: mediaUrl ? interactive?.media?.type : undefined,
        media_urls: mediaUrl ? [mediaUrl] : undefined,
        metadata: {
          message_type: messageType,
          interactive: interactive ? {
            type: interactive.type,
            has_buttons: !!interactive.quickReplyButtons?.length,
            has_list: !!interactive.listSections?.length,
            has_cta: !!interactive.ctaButtons?.length,
            has_media: !!interactive.media,
            has_location: !!interactive.location,
          } : undefined,
        },
      })
      .select('id')
      .single();

    if (saveError) {
      console.error('❌ Error saving outbound message:', saveError);
      throw saveError;
    }

    console.log(`✅ Outbound message saved: ${savedMsg.id}`);

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

    return {
      messageSid: message.sid,
      savedMessageId: savedMsg.id,
      status: 'sent',
    };
  } catch (error) {
    console.error('❌ Error sending WhatsApp message:', error);

    // Tentar salvar mensagem com status de erro
    const { data: savedMsg } = await supabase
      .from('messages')
      .insert({
        organization_id: organizationId,
        thread_id: threadId,
        direction: 'outbound',
        content: messageBody,
        sender_type: 'agent',
        whatsapp_status: 'failed',
        error_message: error instanceof Error ? error.message : 'Unknown error',
        ai_processed: true,
      })
      .select('id')
      .single();

    // Esconder typing mesmo em caso de erro
    await supabase
      .from('message_threads')
      .update({
        agent_typing: false,
        agent_typing_at: null,
      })
      .eq('id', threadId)
      .eq('organization_id', organizationId);

    return {
      messageSid: '',
      savedMessageId: savedMsg?.id || '',
      status: 'failed',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Envia mensagem interativa baseada no tipo
 * Usa Content Templates do Twilio - não faz fallback para texto
 */
async function sendInteractiveMessage(
  client: Twilio,
  from: string,
  to: string,
  interactive: InteractiveMessage
) {
  // Para mídia simples, usar mediaUrl diretamente (mais eficiente)
  if (interactive.type === 'media' && interactive.media) {
    return sendMediaMessage(client, from, to, interactive);
  }

  // Para outros tipos, criar Content Template
  const contentSid = await createContentTemplate(client, interactive);

  if (!contentSid) {
    throw new Error(`Failed to create Content Template for type: ${interactive.type}`);
  }

  console.log(`📋 Using content template: ${contentSid}`);
  return client.messages.create({
    from,
    to,
    contentSid,
  });
}

/**
 * Envia mensagem de mídia (imagem, vídeo, documento, áudio)
 */
async function sendMediaMessage(
  client: Twilio,
  from: string,
  to: string,
  interactive: InteractiveMessage
) {
  const media = interactive.media!;

  return client.messages.create({
    from,
    to,
    body: media.caption || '',
    mediaUrl: [media.url],
  });
}


/**
 * Mostra indicador de digitação
 */
export async function showTypingIndicator(threadId: string, organizationId: string) {
  await supabase
    .from('message_threads')
    .update({
      agent_typing: true,
      agent_typing_at: new Date().toISOString(),
    })
    .eq('id', threadId)
    .eq('organization_id', organizationId);
}

/**
 * Esconde indicador de digitação
 */
export async function hideTypingIndicator(threadId: string, organizationId: string) {
  await supabase
    .from('message_threads')
    .update({
      agent_typing: false,
      agent_typing_at: null,
    })
    .eq('id', threadId)
    .eq('organization_id', organizationId);
}

// =============================================================================
// Funções auxiliares para criar mensagens interativas facilmente
// =============================================================================

/**
 * Cria uma mensagem de Quick Reply
 */
export function createQuickReplyMessage(
  body: string,
  buttons: Array<{ id: string; title: string }>,
  options?: { footer?: string }
): InteractiveMessage {
  return {
    type: 'quick_reply',
    body,
    quickReplyButtons: buttons,
    footer: options?.footer,
  };
}

/**
 * Cria uma mensagem de Lista
 */
export function createListMessage(
  body: string,
  buttonText: string,
  sections: Array<{
    title?: string;
    rows: Array<{ id: string; title: string; description?: string }>;
  }>,
  options?: { footer?: string }
): InteractiveMessage {
  return {
    type: 'list',
    body,
    listButtonText: buttonText,
    listSections: sections,
    footer: options?.footer,
  };
}

/**
 * Cria uma mensagem com botões CTA
 */
export function createCTAMessage(
  body: string,
  buttons: Array<{
    type: 'url' | 'phone';
    title: string;
    url?: string;
    phone?: string;
  }>,
  options?: { footer?: string }
): InteractiveMessage {
  return {
    type: 'cta',
    body,
    ctaButtons: buttons,
    footer: options?.footer,
  };
}

/**
 * Cria uma mensagem de mídia
 */
export function createMediaMessage(
  mediaType: 'image' | 'video' | 'document' | 'audio',
  url: string,
  options?: { caption?: string; filename?: string }
): InteractiveMessage {
  return {
    type: 'media',
    body: options?.caption || '',
    media: {
      type: mediaType,
      url,
      caption: options?.caption,
      filename: options?.filename,
    },
  };
}

/**
 * Cria uma mensagem de localização
 */
export function createLocationMessage(
  latitude: number,
  longitude: number,
  options?: { name?: string; address?: string; body?: string }
): InteractiveMessage {
  return {
    type: 'location',
    body: options?.body || 'Aqui está a localização',
    location: {
      latitude,
      longitude,
      name: options?.name,
      address: options?.address,
    },
  };
}

/**
 * Cria uma mensagem de solicitação de localização
 */
export function createLocationRequestMessage(body: string): InteractiveMessage {
  return {
    type: 'location_request',
    body,
  };
}

/**
 * Cria uma mensagem de Card
 */
export function createCardMessage(
  title: string,
  options?: {
    body?: string;
    imageUrl?: string;
    actions?: Array<{
      type: 'url' | 'phone';
      title: string;
      url?: string;
      phone?: string;
    }>;
  }
): InteractiveMessage {
  return {
    type: 'card',
    body: options?.body || title,
    card: {
      title,
      body: options?.body,
      media: options?.imageUrl ? { type: 'image', url: options.imageUrl } : undefined,
      actions: options?.actions,
    },
  };
}

// Re-export types for convenience
export type {
  InteractiveMessage,
  WhatsAppMessageType,
  QuickReplyButton,
} from '../types/whatsapp-messages.js';
