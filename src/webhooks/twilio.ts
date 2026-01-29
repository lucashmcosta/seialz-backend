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

      // 3. Extrair números
      const customerPhone = body.From.replace('whatsapp:', '');
      const businessPhone = body.To.replace('whatsapp:', '');

      // Ignorar se o "From" for o próprio número da empresa (é uma notificação, não mensagem do cliente)
      if (customerPhone === businessPhone || customerPhone.includes(whatsappConfig.whatsapp_number)) {
        console.log('⚠️ Ignoring message from business number (not a customer message)');
        return reply.status(200).send('');
      }

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
            full_name: body.ProfileName || 'WhatsApp User',
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

      // 8. Salvar mensagem (whatsapp_status não é incluído para inbound - campo é para outbound)
      const { data: savedMessage, error: msgError } = await supabase
        .from('messages')
        .insert({
          organization_id: organizationId,
          thread_id: threadId,
          direction: 'inbound',
          content: messageContent,
          sender_type: 'contact',
          whatsapp_message_sid: body.MessageSid,
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

  // Webhook de status de Content Templates (aprovação WhatsApp)
  // URL: /webhook/twilio/content-status
  // Twilio envia quando o status de aprovação de um template muda
  app.post('/webhook/twilio/content-status', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      ContentSid?: string;
      ApprovalStatus?: string;
      RejectionReason?: string;
      // Campos alternativos que Twilio pode enviar
      content_sid?: string;
      approval_status?: string;
      rejection_reason?: string;
    };

    // Normalizar campos (Twilio pode enviar em diferentes formatos)
    const contentSid = body.ContentSid || body.content_sid;
    const approvalStatus = body.ApprovalStatus || body.approval_status;
    const rejectionReason = body.RejectionReason || body.rejection_reason;

    if (!contentSid) {
      console.error('❌ Missing ContentSid in content status webhook');
      return reply.status(400).send('Missing ContentSid');
    }

    console.log(`📥 Template status update: ${contentSid} -> ${approvalStatus}`);

    try {
      // Buscar template pelo twilio_content_sid
      const { data: template, error: findError } = await supabase
        .from('whatsapp_templates')
        .select('id, organization_id, friendly_name')
        .eq('twilio_content_sid', contentSid)
        .single();

      if (findError || !template) {
        console.warn(`⚠️ Template not found for ContentSid: ${contentSid}`);
        // Retornar 200 mesmo assim para não causar retries do Twilio
        return reply.status(200).send('Template not found');
      }

      // Mapear status do Twilio para nosso formato
      let mappedStatus = approvalStatus?.toLowerCase() || 'pending';
      if (mappedStatus === 'approved') mappedStatus = 'approved';
      else if (mappedStatus === 'rejected') mappedStatus = 'rejected';
      else if (mappedStatus === 'pending') mappedStatus = 'pending';

      // Atualizar status no banco
      const { error: updateError } = await supabase
        .from('whatsapp_templates')
        .update({
          status: mappedStatus,
          rejection_reason: rejectionReason || null,
          last_synced_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', template.id);

      if (updateError) {
        console.error('❌ Error updating template status:', updateError);
        return reply.status(500).send('Error updating status');
      }

      console.log(`✅ Template "${template.friendly_name}" status updated to: ${mappedStatus}`);

      return reply.status(200).send('');

    } catch (error) {
      console.error('❌ Content status webhook error:', error);
      return reply.status(500).send('Internal error');
    }
  });
}
