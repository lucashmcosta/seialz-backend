// src/routes/whatsapp.ts

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import twilio from 'twilio';
import { validateAuth, validateOrganizationAccess } from '../middleware/auth.js';
import { sendWhatsAppMessage } from '../services/whatsapp.js';
import {
  listTemplates,
  createTemplate,
  deleteTemplate,
  syncTemplates,
} from '../services/whatsapp-templates.js';
import {
  setupWhatsAppIntegration,
  getIntegrationStatus,
} from '../services/whatsapp-setup.js';
import { supabase, type QuickReplyButton } from '../lib/supabase.js';

// Types for request bodies
interface SendMessageBody {
  threadId: string;
  organizationId: string;
  content: string;
  type: 'text' | 'media' | 'template' | 'interactive';
  mediaUrl?: string;
  templateId?: string;
  interactive?: {
    type: 'quick_reply' | 'list' | 'cta';
    quickReplyButtons?: QuickReplyButton[];
    listSections?: Array<{
      title: string;
      rows: Array<{ id: string; title: string; description?: string }>;
    }>;
    ctaButtons?: Array<{ type: string; title: string; url?: string; phone?: string }>;
  };
}

interface TemplateQuerystring {
  organizationId: string;
}

interface CreateTemplateBody {
  organizationId: string;
  name: string;
  body: string;
  category: 'MARKETING' | 'UTILITY';
}

interface SyncTemplatesBody {
  organizationId: string;
}

interface SetupBody {
  organizationId: string;
  accountSid: string;
  authToken: string;
  whatsappNumber: string;
  messagingServiceSid?: string;
}

interface TemplateParams {
  id: string;
}

// Helper to validate organization access
async function checkOrgAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  organizationId: string
): Promise<boolean> {
  const hasAccess = await validateOrganizationAccess(request.user.id, organizationId);
  if (!hasAccess) {
    reply.status(403).send({ error: 'Forbidden', message: 'No access to this organization' });
    return false;
  }
  return true;
}

// Get WhatsApp config for organization
async function getWhatsAppConfig(organizationId: string) {
  const { data: integration, error } = await supabase
    .from('organization_integrations')
    .select(`
      config_values,
      admin_integrations!inner(slug)
    `)
    .eq('organization_id', organizationId)
    .eq('admin_integrations.slug', 'twilio-whatsapp')
    .eq('is_enabled', true)
    .single();

  if (error || !integration) {
    throw new Error('WhatsApp integration not configured for organization');
  }

  return integration.config_values as {
    account_sid: string;
    auth_token: string;
    whatsapp_number: string;
    messaging_service_sid?: string;
  };
}

export async function whatsappRoutes(app: FastifyInstance) {
  // Apply auth middleware to all routes in this plugin
  app.addHook('preHandler', validateAuth);

  // ===========================
  // POST /api/whatsapp/send
  // Send messages (text, media, templates, interactive)
  // ===========================
  app.post<{ Body: SendMessageBody }>('/api/whatsapp/send', async (request, reply) => {
    const { threadId, organizationId, content, type, mediaUrl, templateId, interactive } =
      request.body;

    // Validate required fields
    if (!threadId || !organizationId) {
      return reply.status(400).send({ error: 'Bad Request', message: 'threadId and organizationId are required' });
    }

    // Validate organization access
    if (!(await checkOrgAccess(request, reply, organizationId))) {
      return;
    }

    try {
      let result;

      switch (type) {
        case 'text':
          // Use existing sendWhatsAppMessage for text
          result = await sendWhatsAppMessage({
            threadId,
            organizationId,
            content,
            buttons: interactive?.quickReplyButtons,
          });
          break;

        case 'media':
          // Send media message via Twilio
          result = await sendMediaMessage({
            threadId,
            organizationId,
            content,
            mediaUrl: mediaUrl!,
          });
          break;

        case 'template':
          // Send template message
          result = await sendTemplateMessage({
            threadId,
            organizationId,
            templateId: templateId!,
          });
          break;

        case 'interactive':
          // Send interactive message with buttons
          result = await sendWhatsAppMessage({
            threadId,
            organizationId,
            content,
            buttons: interactive?.quickReplyButtons,
          });
          break;

        default:
          // Default to text
          result = await sendWhatsAppMessage({
            threadId,
            organizationId,
            content,
          });
      }

      return reply.send({
        success: true,
        messageId: result.sid,
        twilioSid: result.sid,
      });
    } catch (error: any) {
      request.log.error('Failed to send WhatsApp message:', error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to send message',
        message: error.message,
      });
    }
  });

  // ===========================
  // GET /api/whatsapp/templates
  // List templates for organization
  // ===========================
  app.get<{ Querystring: TemplateQuerystring }>('/api/whatsapp/templates', async (request, reply) => {
    const { organizationId } = request.query;

    if (!organizationId) {
      return reply.status(400).send({ error: 'Bad Request', message: 'organizationId is required' });
    }

    // Validate organization access
    if (!(await checkOrgAccess(request, reply, organizationId))) {
      return;
    }

    try {
      const templates = await listTemplates(organizationId);
      return reply.send({ templates });
    } catch (error: any) {
      request.log.error('Failed to list templates:', error);
      return reply.status(500).send({
        error: 'Failed to list templates',
        message: error.message,
      });
    }
  });

  // ===========================
  // POST /api/whatsapp/templates
  // Create a new template
  // ===========================
  app.post<{ Body: CreateTemplateBody }>('/api/whatsapp/templates', async (request, reply) => {
    const { organizationId, name, body, category } = request.body;

    if (!organizationId || !name || !body) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'organizationId, name, and body are required',
      });
    }

    // Validate organization access
    if (!(await checkOrgAccess(request, reply, organizationId))) {
      return;
    }

    try {
      const template = await createTemplate({
        organizationId,
        name,
        body,
        category: category || 'UTILITY',
      });

      return reply.status(201).send({ template });
    } catch (error: any) {
      request.log.error('Failed to create template:', error);
      return reply.status(500).send({
        error: 'Failed to create template',
        message: error.message,
      });
    }
  });

  // ===========================
  // DELETE /api/whatsapp/templates/:id
  // Delete a template
  // ===========================
  app.delete<{ Params: TemplateParams; Querystring: TemplateQuerystring }>(
    '/api/whatsapp/templates/:id',
    async (request, reply) => {
      const { id } = request.params;
      const { organizationId } = request.query;

      if (!organizationId) {
        return reply.status(400).send({
          error: 'Bad Request',
          message: 'organizationId query parameter is required',
        });
      }

      // Validate organization access
      if (!(await checkOrgAccess(request, reply, organizationId))) {
        return;
      }

      try {
        await deleteTemplate(id, organizationId);
        return reply.status(204).send();
      } catch (error: any) {
        request.log.error('Failed to delete template:', error);

        if (error.message === 'Template not found') {
          return reply.status(404).send({
            error: 'Not Found',
            message: 'Template not found',
          });
        }

        return reply.status(500).send({
          error: 'Failed to delete template',
          message: error.message,
        });
      }
    }
  );

  // ===========================
  // POST /api/whatsapp/templates/sync
  // Sync templates from Twilio
  // ===========================
  app.post<{ Body: SyncTemplatesBody }>('/api/whatsapp/templates/sync', async (request, reply) => {
    const { organizationId } = request.body;

    if (!organizationId) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'organizationId is required',
      });
    }

    // Validate organization access
    if (!(await checkOrgAccess(request, reply, organizationId))) {
      return;
    }

    try {
      const result = await syncTemplates({ organizationId });
      return reply.send({
        success: true,
        synced: result.synced,
        templates: result.templates,
      });
    } catch (error: any) {
      request.log.error('Failed to sync templates:', error);
      return reply.status(500).send({
        error: 'Failed to sync templates',
        message: error.message,
      });
    }
  });

  // ===========================
  // POST /api/whatsapp/setup
  // Setup WhatsApp integration
  // ===========================
  app.post<{ Body: SetupBody }>('/api/whatsapp/setup', async (request, reply) => {
    const { organizationId, accountSid, authToken, whatsappNumber, messagingServiceSid } =
      request.body;

    if (!organizationId || !accountSid || !authToken || !whatsappNumber) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'organizationId, accountSid, authToken, and whatsappNumber are required',
      });
    }

    // Validate organization access
    if (!(await checkOrgAccess(request, reply, organizationId))) {
      return;
    }

    try {
      const result = await setupWhatsAppIntegration({
        organizationId,
        accountSid,
        authToken,
        whatsappNumber,
        messagingServiceSid,
      });

      if (!result.success) {
        return reply.status(400).send({
          success: false,
          error: result.error,
        });
      }

      return reply.send({
        success: true,
        integrationId: result.integrationId,
        webhookUrl: result.webhookUrl,
      });
    } catch (error: any) {
      request.log.error('Failed to setup WhatsApp integration:', error);
      return reply.status(500).send({
        error: 'Failed to setup integration',
        message: error.message,
      });
    }
  });

  // ===========================
  // GET /api/whatsapp/status
  // Get integration status
  // ===========================
  app.get<{ Querystring: TemplateQuerystring }>('/api/whatsapp/status', async (request, reply) => {
    const { organizationId } = request.query;

    if (!organizationId) {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'organizationId is required',
      });
    }

    // Validate organization access
    if (!(await checkOrgAccess(request, reply, organizationId))) {
      return;
    }

    try {
      const status = await getIntegrationStatus(organizationId);
      return reply.send(status);
    } catch (error: any) {
      request.log.error('Failed to get integration status:', error);
      return reply.status(500).send({
        error: 'Failed to get status',
        message: error.message,
      });
    }
  });
}

// Helper function to send media messages
async function sendMediaMessage(options: {
  threadId: string;
  organizationId: string;
  content: string;
  mediaUrl: string;
}) {
  const { threadId, organizationId, content, mediaUrl } = options;

  // Get thread and contact info
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
  const config = await getWhatsAppConfig(organizationId);

  // Send via Twilio with media
  const twilioClient = twilio(config.account_sid, config.auth_token);

  const message = await twilioClient.messages.create({
    body: content || '',
    from: `whatsapp:${config.whatsapp_number}`,
    to: `whatsapp:${customerPhone}`,
    mediaUrl: [mediaUrl],
  });

  // Save message to database
  await supabase.from('messages').insert({
    organization_id: organizationId,
    thread_id: threadId,
    direction: 'outbound',
    content: content || '',
    sender_type: 'agent',
    whatsapp_message_sid: message.sid,
    whatsapp_status: 'sending',
    media_type: 'image',
    media_urls: [mediaUrl],
    ai_processed: true,
  });

  return message;
}

// Helper function to send template messages
async function sendTemplateMessage(options: {
  threadId: string;
  organizationId: string;
  templateId: string;
}) {
  const { threadId, organizationId, templateId } = options;

  // Get template
  const { data: template, error: templateError } = await supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('id', templateId)
    .eq('organization_id', organizationId)
    .single();

  if (templateError || !template) {
    throw new Error(`Template not found: ${templateId}`);
  }

  // Get thread and contact info
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
  const config = await getWhatsAppConfig(organizationId);

  // Send via Twilio
  const twilioClient = twilio(config.account_sid, config.auth_token);

  let message;

  if (template.twilio_content_sid) {
    // Use Twilio Content API
    message = await twilioClient.messages.create({
      from: `whatsapp:${config.whatsapp_number}`,
      to: `whatsapp:${customerPhone}`,
      contentSid: template.twilio_content_sid,
    });
  } else {
    // Send as regular text
    message = await twilioClient.messages.create({
      body: template.body,
      from: `whatsapp:${config.whatsapp_number}`,
      to: `whatsapp:${customerPhone}`,
    });
  }

  // Save message to database
  await supabase.from('messages').insert({
    organization_id: organizationId,
    thread_id: threadId,
    direction: 'outbound',
    content: template.body,
    sender_type: 'agent',
    template_id: templateId,
    whatsapp_message_sid: message.sid,
    whatsapp_status: 'sending',
    ai_processed: true,
  });

  return message;
}
