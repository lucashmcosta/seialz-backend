import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { supabase } from '../lib/supabase.js';
import { inngest } from '../lib/inngest.js';

// Tipos do payload do Twilio
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

/**
 * Registra rotas de webhook do Twilio
 */
export async function twilioWebhookRoutes(app: FastifyInstance) {
  
  // Webhook principal - recebe mensagens do WhatsApp
  app.post('/webhook/twilio/whatsapp', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as TwilioWebhookBody;
    
    console.log(`📥 Incoming WhatsApp message from ${body.From}`);
    
    try {
      // 1. Extrair número do cliente (remover "whatsapp:")
      const customerPhone = body.From.replace('whatsapp:', '');
      const businessPhone = body.To.replace('whatsapp:', '');
      
      // 2. Encontrar organização pelo número de WhatsApp
      const { data: org, error: orgError } = await supabase
        .from('organizations')
        .select('id')
        .eq('whatsapp_phone_number', businessPhone)
        .single();
      
      if (orgError || !org) {
        console.error(`❌ Organization not found for number: ${businessPhone}`);
        return reply.status(404).send('Organization not found');
      }
      
      const organizationId = org.id;
      
      // 3. Encontrar ou criar contato
      let { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('phone', customerPhone)
        .single();
      
      if (!contact) {
        const { data: newContact, error: contactError } = await supabase
          .from('contacts')
          .insert({
            organization_id: organizationId,
            phone: customerPhone,
            first_name: body.ProfileName || 'WhatsApp User',
          })
          .select()
          .single();
        
        if (contactError) {
          console.error('❌ Error creating contact:', contactError);
          return reply.status(500).send('Error creating contact');
        }
        
        contact = newContact;
      }
      
      // 4. Encontrar ou criar thread
      let { data: thread } = await supabase
        .from('message_threads')
        .select('id, awaiting_button_response, button_options')
        .eq('organization_id', organizationId)
        .eq('contact_id', contact.id)
        .eq('channel', 'whatsapp')
        .single();
      
      if (!thread) {
        const { data: newThread, error: threadError } = await supabase
          .from('message_threads')
          .insert({
            organization_id: organizationId,
            contact_id: contact.id,
            channel: 'whatsapp',
            external_id: customerPhone,
          })
          .select()
          .single();
        
        if (threadError) {
          console.error('❌ Error creating thread:', threadError);
          return reply.status(500).send('Error creating thread');
        }
        
        thread = newThread;
      }
      
      // 5. Processar conteúdo da mensagem
      let messageContent = body.Body || '';
      
      // Verificar se é resposta de botão
      if (thread.awaiting_button_response && thread.button_options) {
        const optionNumber = parseInt(messageContent.trim());
        const buttons = thread.button_options as { id: string; title: string }[];
        
        if (optionNumber >= 1 && optionNumber <= buttons.length) {
          console.log(`🔘 Button response detected: ${optionNumber}`);
          // Não converte aqui, deixa para o batch processor
        }
      }
      
      // 6. Determinar tipo de mídia
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
      
      // 7. Salvar mensagem (MULTI-TENANT)
      const { data: savedMessage, error: msgError } = await supabase
        .from('messages')
        .insert({
          organization_id: organizationId,
          thread_id: thread.id,
          direction: 'inbound',
          content: messageContent,
          sender_type: 'contact',
          whatsapp_message_sid: body.MessageSid,
          whatsapp_status: 'received',
          media_type: mediaType,
          media_urls: mediaUrls,
          ai_processed: false, // Importante: começa como false
        })
        .select()
        .single();
      
      if (msgError) {
        console.error('❌ Error saving message:', msgError);
        return reply.status(500).send('Error saving message');
      }
      
      // 8. Atualizar thread
      await supabase
        .from('message_threads')
        .update({
          whatsapp_last_inbound_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', thread.id)
        .eq('organization_id', organizationId);
      
      // 9. Disparar evento para Inngest (debounce de 5s)
      await inngest.send({
        name: 'whatsapp/message.received',
        data: {
          threadId: thread.id,
          organizationId,
          messageId: savedMessage.id,
          contactId: contact.id,
        },
      });
      
      console.log(`✅ Message queued for processing: ${savedMessage.id}`);
      
      // Twilio espera resposta vazia ou TwiML
      return reply.status(200).send('');
      
    } catch (error) {
      console.error('❌ Webhook error:', error);
      return reply.status(500).send('Internal error');
    }
  });
  
  // Webhook de status (delivery reports)
  app.post('/webhook/twilio/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as {
      MessageSid: string;
      MessageStatus: string;
      ErrorCode?: string;
      ErrorMessage?: string;
    };
    
    console.log(`📊 Status update: ${body.MessageSid} → ${body.MessageStatus}`);
    
    // Atualizar status da mensagem
    await supabase
      .from('messages')
      .update({
        whatsapp_status: body.MessageStatus,
        error_code: body.ErrorCode,
        error_message: body.ErrorMessage,
      })
      .eq('whatsapp_message_sid', body.MessageSid);
    
    return reply.status(200).send('');
  });
}
