// src/webhooks/twilio.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { inngest } from '../lib/inngest.js';

interface TwilioWebhookBody {
  MessageSid: string;
  AccountSid: string;
  From: string;
  To: string;
  Body?: string;
  NumMedia?: string;
  MediaUrl0?: string;
  MediaContentType0?: string;
  ProfileName?: string;
}

interface WhatsAppConfig {
  account_sid: string;
  auth_token: string;
  messaging_service_sid?: string;
  whatsapp_number: string;
}

export async function twilioWebhookRoutes(app: FastifyInstance) {

  // Webhook principal - recebe mensagens do WhatsApp
  // URL: /webhook/twilio/whatsapp?orgId=xxx
  app.post('/webhook/twilio/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as TwilioWebhookBody;

    // 1. Pegar orgId da query string (padrão existente)
    const query = request.query as { orgId?: string };
    const organizationId = query.orgId;

    if (!organizationId) {
      console.error('❌ Missing orgId in webhook URL');
      return reply.status(400).send('Missing orgId parameter');
    }

    console.log(`📥 Incoming WhatsApp message for org: ${organizationId}`);

    try {
      // 2. Buscar configuração do WhatsApp desta org
      const { data: integration, error: integrationError } = await supabase
        .from('organization_integrations')
        .select(`
          id,
          config_values,
          organization_id,
          admin_integrations!inner(slug)
        `)
        .eq('organization_id', organizationId)
        .eq('admin_integrations.slug', 'twilio-whatsapp')
        .eq('is_enabled', true)
        .single();

      if (integrationError || !integration) {
        console.error(`❌ WhatsApp integration not found for org: ${organizationId}`);
        return reply.status(404).send('Integration not found');
      }

      const whatsappConfig = integration.config_values as WhatsAppConfig;

      // 3. Extrair número do cliente
      const customerPhone = body.From.replace('whatsapp:', '');

      // 4. Encontrar ou criar contato
      const { data: existingContact } = await supabase
        .from('contacts')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('phone', customerPhone)
        .single();

      let contactId: string;

      if (existingContact) {
        contactId = existingContact.id;
      } else {
        const { data: newContact, error: contactError } = await supabase
          .from('contacts')
          .insert({
            organization_id: organizationId,
            phone: customerPhone,
            first_name: body.ProfileName || 'WhatsApp User',
          })
          .select('id')
          .single();

        if (contactError || !newContact) {
          console.error('❌ Error creating contact:', contactError);
          return reply.status(500).send('Error creating contact');
        }

        contactId = newContact.id;
      }

      // 5. Encontrar ou criar thread
      const { data: existingThread } = await supabase
        .from('message_threads')
        .select('id, awaiting_button_response, button_options')
        .eq('organization_id', organizationId)
        .eq('contact_id', contactId)
        .eq('channel', 'whatsapp')
        .single();

      let threadId: string;
      let awaitingButtonResponse = false;
      let buttonOptions: { id: string; title: string }[] | null = null;

      if (existingThread) {
        threadId = existingThread.id;
        awaitingButtonResponse = existingThread.awaiting_button_response || false;
        buttonOptions = existingThread.button_options as { id: string; title: string }[] | null;
      } else {
        const { data: newThread, error: threadError } = await supabase
          .from('message_threads')
          .insert({
            organization_id: organizationId,
            contact_id: contactId,
            channel: 'whatsapp',
            external_id: customerPhone,
          })
          .select('id')
          .single();

        if (threadError || !newThread) {
          console.error('❌ Error creating thread:', threadError);
          return reply.status(500).send('Error creating thread');
        }

        threadId = newThread.id;
      }

      // 6. Processar conteúdo da mensagem
      const messageContent = body.Body || '';

      // 7. Determinar tipo de mídia
      let mediaType: string | null = null;
      const mediaUrls: string[] = [];

      if (body.NumMedia && parseInt(body.NumMedia) > 0) {
        if (body.MediaUrl0) {
          mediaUrls.push(body.MediaUrl0);
        }
        if (body.MediaContentType0) {
          if (body.MediaContentType0.startsWith('image/')) mediaType = 'image';
          else if (body.MediaContentType0.startsWith('video/')) mediaType = 'video';
          else if (body.MediaContentType0.startsWith('audio/')) mediaType = 'audio';
          else mediaType = 'document';
        }
      }

      // 8. Salvar mensagem
      const { data: savedMessage, error: msgError } = await supabase
        .from('messages')
        .insert({
          organization_id: organizationId,
          thread_id: threadId,
          direction: 'inbound',
          content: messageContent,
          sender_type: 'contact',
          whatsapp_message_sid: body.MessageSid,
          whatsapp_status: 'received',
          media_type: mediaType,
          media_urls: mediaUrls,
          ai_processed: false,
        })
        .select('id')
        .single();

      if (msgError || !savedMessage) {
        console.error('❌ Error saving message:', msgError);
        return reply.status(500).send('Error saving message');
      }

      // 9. Atualizar thread
      await supabase
        .from('message_threads')
        .update({
          whatsapp_last_inbound_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', threadId)
        .eq('organization_id', organizationId);

      // 10. Disparar evento para Inngest (debounce de 5s)
      await inngest.send({
        name: 'whatsapp/message.received',
        data: {
          threadId,
          organizationId,
          messageId: savedMessage.id,
          contactId,
        },
      });

      console.log(`✅ Message queued for processing: ${savedMessage.id}`);

      return reply.status(200).send('');

    } catch (error) {
      console.error('❌ Webhook error:', error);
      return reply.status(500).send('Internal error');
    }
  });

  // Webhook de status
  // URL: /webhook/twilio/status?orgId=xxx
  app.post('/webhook/twilio/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { orgId?: string };
    const organizationId = query.orgId;

    const body = request.body as {
      MessageSid: string;
      MessageStatus: string;
      ErrorCode?: string;
      ErrorMessage?: string;
    };

    console.log(`📊 Status update: ${body.MessageSid} → ${body.MessageStatus}`);

    // Atualizar status (com org_id se disponível para segurança)
    const updateQuery = supabase
      .from('messages')
      .update({
        whatsapp_status: body.MessageStatus,
        error_code: body.ErrorCode,
        error_message: body.ErrorMessage,
      })
      .eq('whatsapp_message_sid', body.MessageSid);

    if (organizationId) {
      updateQuery.eq('organization_id', organizationId);
    }

    await updateQuery;

    return reply.status(200).send('');
  });
}
