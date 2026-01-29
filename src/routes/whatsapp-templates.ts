// src/routes/whatsapp-templates.ts
// Rotas da API de WhatsApp Templates

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  listTemplates,
  getTemplate,
  getTemplateActions,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  submitForApproval,
  getApprovalStatus,
  syncAllTemplates,
  sendTemplateMessage,
  listTemplatesFromTwilio,
} from '../services/twilio-whatsapp-templates.js';
import {
  validateTemplate,
  type TemplateVariable,
  type TemplateButton,
  type TemplateAction,
} from '../lib/template-validation.js';

// ===========================
// TYPES
// ===========================

interface OrgIdQuery {
  orgId?: string;
}

interface TemplateIdParams {
  id: string;
}

interface CreateTemplateBody {
  organization_id: string;
  friendly_name: string;
  language?: string;
  template_type: string;
  category?: string;
  body: string;
  header?: string;
  footer?: string;
  variables?: TemplateVariable[];
  buttons?: TemplateButton[];
  actions?: TemplateAction[];
}

interface UpdateTemplateBody {
  organization_id: string;
  friendly_name?: string;
  language?: string;
  template_type?: string;
  category?: string;
  body?: string;
  header?: string;
  footer?: string;
  variables?: TemplateVariable[];
  buttons?: TemplateButton[];
  actions?: TemplateAction[];
}

interface ApproveTemplateBody {
  category?: string;
}

interface SendMessageBody {
  organization_id: string;
  to: string;
  template_id: string;
  variables?: Record<string, string>;
  thread_id?: string;
}

interface ListTemplatesQuery extends OrgIdQuery {
  status?: string;
  template_type?: string;
  is_active?: string;
  source?: string; // 'user', 'twilio_sample', 'twilio_tryout', 'all'
}

// ===========================
// ROUTES
// ===========================

export async function whatsappTemplateRoutes(app: FastifyInstance) {

  // ===========================
  // GET /api/whatsapp/templates
  // Lista templates de uma organização
  // Query params:
  //   - orgId (required)
  //   - status: approved, pending, rejected, not_submitted, sample
  //   - template_type: text, quick-reply, list-picker, call-to-action, media
  //   - is_active: true/false
  //   - source: user (default), twilio_sample, twilio_tryout, all
  // ===========================
  app.get('/api/whatsapp/templates', async (
    request: FastifyRequest<{ Querystring: ListTemplatesQuery }>,
    reply: FastifyReply
  ) => {
    const { orgId, status, template_type, is_active, source } = request.query;

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      const templates = await listTemplates(orgId, {
        status,
        template_type,
        is_active: is_active === 'true' ? true : is_active === 'false' ? false : undefined,
        source: source || 'user', // Por padrão, mostrar apenas templates do usuário
      });

      return reply.send(templates);
    } catch (error: any) {
      console.error('❌ Error listing templates:', error);
      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // GET /api/whatsapp/templates/:id
  // Busca um template específico com suas ações
  // ===========================
  app.get('/api/whatsapp/templates/:id', async (
    request: FastifyRequest<{ Params: TemplateIdParams; Querystring: OrgIdQuery }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const { orgId } = request.query;

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      const template = await getTemplate(orgId, id);

      if (!template) {
        return reply.status(404).send({ error: 'Template not found' });
      }

      // Buscar ações do template
      const actions = await getTemplateActions(id);

      return reply.send({ ...template, actions });
    } catch (error: any) {
      console.error('❌ Error getting template:', error);
      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // POST /api/whatsapp/templates
  // Cria um novo template
  // ===========================
  app.post('/api/whatsapp/templates', async (
    request: FastifyRequest<{ Body: CreateTemplateBody }>,
    reply: FastifyReply
  ) => {
    const body = request.body;

    if (!body.organization_id) {
      return reply.status(400).send({ error: 'Missing organization_id' });
    }

    // Validar template
    const validation = validateTemplate({
      friendly_name: body.friendly_name,
      template_type: body.template_type,
      body: body.body,
      header: body.header,
      footer: body.footer,
      variables: body.variables,
      buttons: body.buttons,
      actions: body.actions,
      category: body.category,
    });

    if (!validation.valid) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: validation.errors,
      });
    }

    try {
      const template = await createTemplate(body.organization_id, {
        friendly_name: body.friendly_name,
        language: body.language,
        template_type: body.template_type,
        body: body.body,
        header: body.header,
        footer: body.footer,
        variables: body.variables,
        buttons: body.buttons,
        actions: body.actions,
        category: body.category,
      });

      return reply.status(201).send(template);
    } catch (error: any) {
      console.error('❌ Error creating template:', error);
      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // PUT /api/whatsapp/templates/:id
  // Atualiza um template existente
  // ===========================
  app.put('/api/whatsapp/templates/:id', async (
    request: FastifyRequest<{ Params: TemplateIdParams; Body: UpdateTemplateBody }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const body = request.body;

    if (!body.organization_id) {
      return reply.status(400).send({ error: 'Missing organization_id' });
    }

    // Validar campos fornecidos
    if (body.friendly_name || body.body || body.template_type) {
      // Buscar template existente para merge
      const existing = await getTemplate(body.organization_id, id);
      if (!existing) {
        return reply.status(404).send({ error: 'Template not found' });
      }

      const validation = validateTemplate({
        friendly_name: body.friendly_name || existing.friendly_name,
        template_type: body.template_type || existing.template_type,
        body: body.body || existing.body,
        header: body.header !== undefined ? body.header : existing.header,
        footer: body.footer !== undefined ? body.footer : existing.footer,
        variables: body.variables || (existing.variables as TemplateVariable[]),
        buttons: body.buttons,
        actions: body.actions,
        category: body.category || existing.category,
      });

      if (!validation.valid) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: validation.errors,
        });
      }
    }

    try {
      const template = await updateTemplate(body.organization_id, id, {
        friendly_name: body.friendly_name,
        language: body.language,
        template_type: body.template_type,
        body: body.body,
        header: body.header,
        footer: body.footer,
        variables: body.variables,
        buttons: body.buttons,
        actions: body.actions,
        category: body.category,
      });

      return reply.send(template);
    } catch (error: any) {
      console.error('❌ Error updating template:', error);

      if (error.message === 'Template not found') {
        return reply.status(404).send({ error: error.message });
      }

      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // DELETE /api/whatsapp/templates/:id
  // Deleta um template (soft delete)
  // ===========================
  app.delete('/api/whatsapp/templates/:id', async (
    request: FastifyRequest<{ Params: TemplateIdParams; Querystring: OrgIdQuery }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const { orgId } = request.query;

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      await deleteTemplate(orgId, id);
      return reply.status(204).send();
    } catch (error: any) {
      console.error('❌ Error deleting template:', error);

      if (error.message === 'Template not found') {
        return reply.status(404).send({ error: error.message });
      }

      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // POST /api/whatsapp/templates/:id/approve
  // Submete template para aprovação do WhatsApp
  // ===========================
  app.post('/api/whatsapp/templates/:id/approve', async (
    request: FastifyRequest<{ Params: TemplateIdParams; Querystring: OrgIdQuery; Body: ApproveTemplateBody }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const { orgId } = request.query;
    const body = request.body || {};

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      const result = await submitForApproval(orgId, id, body.category);
      return reply.send(result);
    } catch (error: any) {
      console.error('❌ Error submitting for approval:', error);

      if (error.message === 'Template not found') {
        return reply.status(404).send({ error: error.message });
      }

      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // GET /api/whatsapp/templates/:id/status
  // Busca status de aprovação de um template
  // ===========================
  app.get('/api/whatsapp/templates/:id/status', async (
    request: FastifyRequest<{ Params: TemplateIdParams; Querystring: OrgIdQuery }>,
    reply: FastifyReply
  ) => {
    const { id } = request.params;
    const { orgId } = request.query;

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      const result = await getApprovalStatus(orgId, id);
      return reply.send(result);
    } catch (error: any) {
      console.error('❌ Error getting approval status:', error);

      if (error.message === 'Template not found') {
        return reply.status(404).send({ error: error.message });
      }

      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // POST /api/whatsapp/templates/sync
  // Sincroniza templates do Twilio com o banco
  // ===========================
  app.post('/api/whatsapp/templates/sync', async (
    request: FastifyRequest<{ Querystring: OrgIdQuery }>,
    reply: FastifyReply
  ) => {
    const { orgId } = request.query;

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      const result = await syncAllTemplates(orgId);
      return reply.send({
        message: 'Sync completed',
        ...result,
      });
    } catch (error: any) {
      console.error('❌ Error syncing templates:', error);
      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // GET /api/whatsapp/templates/twilio
  // Lista templates diretamente do Twilio
  // ===========================
  app.get('/api/whatsapp/templates/twilio', async (
    request: FastifyRequest<{ Querystring: OrgIdQuery }>,
    reply: FastifyReply
  ) => {
    const { orgId } = request.query;

    if (!orgId) {
      return reply.status(400).send({ error: 'Missing orgId parameter' });
    }

    try {
      const templates = await listTemplatesFromTwilio(orgId);
      return reply.send(templates);
    } catch (error: any) {
      console.error('❌ Error listing Twilio templates:', error);
      return reply.status(500).send({ error: error.message });
    }
  });

  // ===========================
  // POST /api/whatsapp/send
  // Envia mensagem usando um template
  // ===========================
  app.post('/api/whatsapp/send', async (
    request: FastifyRequest<{ Body: SendMessageBody }>,
    reply: FastifyReply
  ) => {
    const body = request.body;

    if (!body.organization_id) {
      return reply.status(400).send({ error: 'Missing organization_id' });
    }

    if (!body.to) {
      return reply.status(400).send({ error: 'Missing "to" phone number' });
    }

    if (!body.template_id) {
      return reply.status(400).send({ error: 'Missing template_id' });
    }

    // Validar formato do número
    const phoneRegex = /^\+?[1-9]\d{1,14}$/;
    const cleanPhone = body.to.replace('whatsapp:', '').replace(/\s/g, '');
    if (!phoneRegex.test(cleanPhone)) {
      return reply.status(400).send({ error: 'Invalid phone number format. Use E.164 format (e.g., +5511999999999)' });
    }

    try {
      const result = await sendTemplateMessage(body.organization_id, {
        to: cleanPhone,
        template_id: body.template_id,
        variables: body.variables,
        thread_id: body.thread_id,
      });

      return reply.send(result);
    } catch (error: any) {
      console.error('❌ Error sending template message:', error);

      if (error.message === 'Template not found') {
        return reply.status(404).send({ error: error.message });
      }

      if (error.message === 'Template is not active') {
        return reply.status(400).send({ error: error.message });
      }

      return reply.status(500).send({ error: error.message });
    }
  });
}
