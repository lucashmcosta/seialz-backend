// src/services/twilio-whatsapp-templates.ts
// Serviço para gerenciar WhatsApp Business Message Templates via Twilio Content API
//
// IMPORTANTE: A Content API do Twilio é acessada via HTTP direto (fetch).
// O SDK do Twilio (client.messages.create) é usado APENAS para enviar mensagens.

import twilio from 'twilio';
import type { Twilio } from 'twilio';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import type { TemplateVariable, TemplateButton, TemplateAction } from '../lib/template-validation.js';

// ===========================
// CONSTANTS
// ===========================

const TWILIO_CONTENT_API_BASE = 'https://content.twilio.com/v1';

// ===========================
// TYPES
// ===========================

export interface WhatsAppTemplate {
  id: string;
  organization_id: string;
  twilio_content_sid: string;
  friendly_name: string;
  language: string;
  template_type: string;
  body: string;
  header?: string;
  footer?: string;
  variables?: TemplateVariable[];
  status: string;
  rejection_reason?: string;
  category?: string;
  is_active: boolean;
  source?: string; // 'user', 'twilio_sample', 'twilio_tryout'
  last_synced_at?: string;
  created_at: string;
  updated_at: string;
}

export interface TemplateAction_DB {
  id: string;
  template_id: string;
  type: string;
  title: string;
  value?: string;
  description?: string;
  section?: string;
  position: number;
  created_at: string;
}

interface WhatsAppConfig {
  account_sid: string;
  auth_token: string;
  messaging_service_sid?: string;
  whatsapp_number: string;
}

interface CreateTemplateInput {
  friendly_name: string;
  language?: string;
  template_type: string;
  body: string;
  header?: string;
  footer?: string;
  variables?: TemplateVariable[];
  buttons?: TemplateButton[];
  actions?: TemplateAction[];
  category?: string;
}

interface SendMessageInput {
  to: string;
  template_id: string;
  variables?: Record<string, string>;
  thread_id?: string;
}

interface TwilioContentResponse {
  sid: string;
  friendly_name: string;
  language: string;
  types: Record<string, any>;
  date_created: string;
  date_updated: string;
}

// ===========================
// HELPERS - CONFIG
// ===========================

/**
 * Busca configuração do Twilio WhatsApp para uma organização
 */
async function getWhatsAppConfig(organizationId: string): Promise<WhatsAppConfig | null> {
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
    console.error(`❌ WhatsApp config not found for org: ${organizationId}`);
    return null;
  }

  return integration.config_values as WhatsAppConfig;
}

/**
 * Cria cliente Twilio para envio de mensagens (SDK)
 * NOTA: Usar apenas para client.messages.create()
 */
async function getTwilioClient(organizationId: string): Promise<{ client: Twilio; config: WhatsAppConfig } | null> {
  const config = await getWhatsAppConfig(organizationId);
  if (!config) return null;

  const client = twilio(config.account_sid, config.auth_token);
  return { client, config };
}

/**
 * Gera header de autenticação Basic para a Content API
 */
function getAuthHeader(config: WhatsAppConfig): string {
  return 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64');
}

// ===========================
// HELPERS - CONTENT API (HTTP)
// ===========================

/**
 * Cria um Content Template no Twilio via HTTP
 * POST https://content.twilio.com/v1/Content
 */
async function createTwilioContent(
  config: WhatsAppConfig,
  payload: object
): Promise<TwilioContentResponse> {
  console.log('📤 Twilio Content API - Creating template:', JSON.stringify(payload, null, 2));

  const response = await fetch(`${TWILIO_CONTENT_API_BASE}/Content`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': getAuthHeader(config),
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('❌ Twilio Content API error:', errorData);
    throw new Error(errorData.message || `Failed to create content: ${response.status}`);
  }

  return response.json();
}

/**
 * Lista Content Templates do Twilio via HTTP
 * GET https://content.twilio.com/v1/Content
 */
async function listTwilioContents(
  config: WhatsAppConfig,
  limit: number = 100
): Promise<TwilioContentResponse[]> {
  const response = await fetch(`${TWILIO_CONTENT_API_BASE}/Content?PageSize=${limit}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(config),
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to list contents: ${response.status}`);
  }

  const data = await response.json();
  return data.contents || [];
}

/**
 * Busca um Content Template do Twilio via HTTP
 * GET https://content.twilio.com/v1/Content/{sid}
 */
async function getTwilioContent(
  config: WhatsAppConfig,
  contentSid: string
): Promise<TwilioContentResponse | null> {
  const response = await fetch(`${TWILIO_CONTENT_API_BASE}/Content/${contentSid}`, {
    method: 'GET',
    headers: {
      'Authorization': getAuthHeader(config),
    },
  });

  if (!response.ok) {
    if (response.status === 404) return null;
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.message || `Failed to get content: ${response.status}`);
  }

  return response.json();
}

/**
 * Deleta um Content Template do Twilio via HTTP
 * DELETE https://content.twilio.com/v1/Content/{sid}
 */
async function deleteTwilioContent(
  config: WhatsAppConfig,
  contentSid: string
): Promise<boolean> {
  const response = await fetch(`${TWILIO_CONTENT_API_BASE}/Content/${contentSid}`, {
    method: 'DELETE',
    headers: {
      'Authorization': getAuthHeader(config),
    },
  });

  // 204 = success, 404 = already deleted
  return response.ok || response.status === 404;
}

// ===========================
// HELPERS - TEMPLATE SOURCE DETECTION
// ===========================

/**
 * Detecta a origem de um template baseado no nome
 * Templates da Twilio (sample/tryout) não devem ser considerados "approved"
 */
function detectTemplateSource(friendlyName: string | undefined): 'user' | 'twilio_sample' | 'twilio_tryout' {
  if (!friendlyName) return 'twilio_sample';

  const name = friendlyName.toLowerCase();

  // Templates de Tryout (sandbox da Twilio)
  if (name.includes('tryout') || name.includes('try out')) {
    return 'twilio_tryout';
  }

  // Templates de exemplo/sample da Twilio
  if (
    name.includes('sample') ||
    name.includes('verification') ||
    name.includes('verifications_') ||
    name.includes('appointment_reminder') ||
    name.includes('order_notification') ||
    name.includes('shipping_update') ||
    name.startsWith('hx') // Templates sem nome amigável (apenas o SID)
  ) {
    return 'twilio_sample';
  }

  // Se não bate com nenhum padrão, assume que é do usuário
  return 'user';
}

/**
 * Verifica se um template é de amostra/tryout (não deve ser usado em produção)
 */
function isSampleOrTryoutTemplate(friendlyName: string | undefined): boolean {
  const source = detectTemplateSource(friendlyName);
  return source === 'twilio_sample' || source === 'twilio_tryout';
}

// ===========================
// HELPERS - PAYLOAD BUILDER
// ===========================

/**
 * Constrói o payload para a Twilio Content API baseado no tipo de template
 * Formato: { friendly_name, language, types: { "twilio/text": { body } } }
 */
function buildTwilioContentPayload(data: CreateTemplateInput): object {
  const types: Record<string, object> = {};

  switch (data.template_type) {
    case 'text':
      types['twilio/text'] = {
        body: data.body,
      };
      break;

    case 'quick-reply':
      if (data.buttons && data.buttons.length > 0) {
        types['twilio/quick-reply'] = {
          body: data.body,
          actions: data.buttons.map(btn => ({
            id: btn.id,
            title: btn.title,
          })),
        };
      } else {
        types['twilio/text'] = { body: data.body };
      }
      break;

    case 'call-to-action':
      if (data.actions && data.actions.length > 0) {
        types['twilio/call-to-action'] = {
          body: data.body,
          actions: data.actions
            .filter(a => a.type === 'url' || a.type === 'phone')
            .map(action => {
              if (action.type === 'url') {
                return { type: 'URL', title: action.title, url: action.url };
              } else {
                return { type: 'PHONE_NUMBER', title: action.title, phone: action.phone };
              }
            }),
        };
      } else {
        types['twilio/text'] = { body: data.body };
      }
      break;

    case 'list-picker':
      if (data.actions && data.actions.length > 0) {
        const listItems = data.actions.filter(a => a.type === 'list_item');
        types['twilio/list-picker'] = {
          body: data.body,
          button: 'Ver opções',
          items: listItems.map((item, index) => ({
            id: `item_${index}`,
            item: item.title,
            description: item.description,
          })),
        };
      } else {
        types['twilio/text'] = { body: data.body };
      }
      break;

    case 'media':
    default:
      types['twilio/text'] = { body: data.body };
      break;
  }

  // Payload final conforme documentação Twilio
  const payload: Record<string, any> = {
    friendly_name: data.friendly_name,
    language: data.language || 'pt_BR',
    types,
  };

  // Incluir variáveis se existirem
  if (data.variables && data.variables.length > 0) {
    payload.variables = data.variables.reduce((acc, v) => {
      acc[v.key] = v.example;
      return acc;
    }, {} as Record<string, string>);
  }

  return payload;
}

// ===========================
// DATABASE OPERATIONS
// ===========================

/**
 * Lista templates de uma organização
 * @param filters.source - 'user' (default), 'twilio_sample', 'twilio_tryout', ou 'all'
 */
export async function listTemplates(
  organizationId: string,
  filters?: {
    status?: string;
    template_type?: string;
    is_active?: boolean;
    source?: string;
  }
): Promise<WhatsAppTemplate[]> {
  let query = supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (filters?.status) {
    query = query.eq('status', filters.status);
  }
  if (filters?.template_type) {
    query = query.eq('template_type', filters.template_type);
  }
  if (filters?.is_active !== undefined) {
    query = query.eq('is_active', filters.is_active);
  }

  // Filtrar por source (origem do template)
  // 'all' = mostrar todos, caso contrário filtrar pelo valor específico
  if (filters?.source && filters.source !== 'all') {
    query = query.eq('source', filters.source);
  }

  const { data, error } = await query;

  if (error) {
    console.error('❌ Error listing templates:', error);
    throw new Error(`Failed to list templates: ${error.message}`);
  }

  return data || [];
}

/**
 * Busca um template por ID
 */
export async function getTemplate(
  organizationId: string,
  templateId: string
): Promise<WhatsAppTemplate | null> {
  const { data, error } = await supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('organization_id', organizationId)
    .eq('id', templateId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    console.error('❌ Error getting template:', error);
    throw new Error(`Failed to get template: ${error.message}`);
  }

  return data;
}

/**
 * Busca ações de um template
 */
export async function getTemplateActions(templateId: string): Promise<TemplateAction_DB[]> {
  const { data, error } = await supabase
    .from('whatsapp_template_actions')
    .select('*')
    .eq('template_id', templateId)
    .order('position', { ascending: true });

  if (error) {
    console.error('❌ Error getting template actions:', error);
    return [];
  }

  return data || [];
}

/**
 * Salva ações do template
 */
async function saveTemplateActions(
  templateId: string,
  buttons?: TemplateButton[],
  actions?: TemplateAction[]
): Promise<void> {
  // Deletar ações existentes
  await supabase
    .from('whatsapp_template_actions')
    .delete()
    .eq('template_id', templateId);

  const actionsToInsert: Partial<TemplateAction_DB>[] = [];

  if (buttons && buttons.length > 0) {
    buttons.forEach((btn, index) => {
      actionsToInsert.push({
        template_id: templateId,
        type: 'quick_reply',
        title: btn.title,
        value: btn.id,
        position: index,
      });
    });
  }

  if (actions && actions.length > 0) {
    actions.forEach((action, index) => {
      actionsToInsert.push({
        template_id: templateId,
        type: action.type,
        title: action.title,
        value: action.type === 'url' ? action.url : action.type === 'phone' ? action.phone : action.code,
        description: action.description,
        section: action.section,
        position: buttons ? buttons.length + index : index,
      });
    });
  }

  if (actionsToInsert.length > 0) {
    const { error } = await supabase
      .from('whatsapp_template_actions')
      .insert(actionsToInsert);

    if (error) {
      console.error('❌ Error saving template actions:', error);
    }
  }
}

// ===========================
// TWILIO CONTENT API OPERATIONS
// ===========================

/**
 * Cria um template no Twilio e salva no banco
 */
export async function createTemplate(
  organizationId: string,
  data: CreateTemplateInput
): Promise<WhatsAppTemplate> {
  console.log(`📝 Creating template "${data.friendly_name}" for org: ${organizationId}`);

  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  try {
    // 1. Criar no Twilio Content API via HTTP
    const payload = buildTwilioContentPayload(data);
    const content = await createTwilioContent(config, payload);

    console.log(`✅ Created Twilio content: ${content.sid}`);

    // 2. Salvar no banco
    const { data: template, error } = await supabase
      .from('whatsapp_templates')
      .insert({
        organization_id: organizationId,
        twilio_content_sid: content.sid,
        friendly_name: data.friendly_name,
        language: data.language || 'pt_BR',
        template_type: data.template_type,
        body: data.body,
        header: data.header,
        footer: data.footer,
        variables: data.variables || [],
        status: 'not_submitted',
        category: data.category,
        source: 'user', // Templates criados pelo usuário
        is_active: true,
      })
      .select()
      .single();

    if (error || !template) {
      // Rollback: deletar do Twilio
      await deleteTwilioContent(config, content.sid);
      throw new Error(`Failed to save template: ${error?.message}`);
    }

    // 3. Salvar ações
    await saveTemplateActions(template.id, data.buttons, data.actions);

    console.log(`✅ Template saved: ${template.id}`);
    return template;

  } catch (error: any) {
    console.error('❌ Error creating template:', error);
    throw new Error(`Failed to create template: ${error.message}`);
  }
}

/**
 * Atualiza um template (deleta o antigo no Twilio e cria um novo)
 */
export async function updateTemplate(
  organizationId: string,
  templateId: string,
  data: Partial<CreateTemplateInput>
): Promise<WhatsAppTemplate> {
  console.log(`📝 Updating template ${templateId} for org: ${organizationId}`);

  const existing = await getTemplate(organizationId, templateId);
  if (!existing) {
    throw new Error('Template not found');
  }

  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  try {
    // 1. Deletar o Content antigo do Twilio
    if (existing.twilio_content_sid) {
      const deleted = await deleteTwilioContent(config, existing.twilio_content_sid);
      if (deleted) {
        console.log(`🗑️ Deleted old Twilio content: ${existing.twilio_content_sid}`);
      }
    }

    // 2. Criar novo Content no Twilio com dados mesclados
    const mergedData: CreateTemplateInput = {
      friendly_name: data.friendly_name || existing.friendly_name,
      language: data.language || existing.language,
      template_type: data.template_type || existing.template_type,
      body: data.body || existing.body,
      header: data.header !== undefined ? data.header : existing.header,
      footer: data.footer !== undefined ? data.footer : existing.footer,
      variables: data.variables || (existing.variables as TemplateVariable[]),
      buttons: data.buttons,
      actions: data.actions,
      category: data.category || existing.category,
    };

    const payload = buildTwilioContentPayload(mergedData);
    const content = await createTwilioContent(config, payload);

    console.log(`✅ Created new Twilio content: ${content.sid}`);

    // 3. Atualizar no banco
    const { data: template, error } = await supabase
      .from('whatsapp_templates')
      .update({
        twilio_content_sid: content.sid,
        friendly_name: mergedData.friendly_name,
        language: mergedData.language,
        template_type: mergedData.template_type,
        body: mergedData.body,
        header: mergedData.header,
        footer: mergedData.footer,
        variables: mergedData.variables || [],
        category: mergedData.category,
        status: 'not_submitted',
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId)
      .eq('id', templateId)
      .select()
      .single();

    if (error || !template) {
      throw new Error(`Failed to update template: ${error?.message}`);
    }

    // 4. Atualizar ações
    if (data.buttons || data.actions) {
      await saveTemplateActions(template.id, data.buttons, data.actions);
    }

    console.log(`✅ Template updated: ${template.id}`);
    return template;

  } catch (error: any) {
    console.error('❌ Error updating template:', error);
    throw new Error(`Failed to update template: ${error.message}`);
  }
}

/**
 * Deleta um template (soft delete no banco, remove do Twilio)
 */
export async function deleteTemplate(
  organizationId: string,
  templateId: string
): Promise<void> {
  console.log(`🗑️ Deleting template ${templateId} for org: ${organizationId}`);

  const template = await getTemplate(organizationId, templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  const config = await getWhatsAppConfig(organizationId);

  // Deletar do Twilio (se configurado)
  if (config && template.twilio_content_sid) {
    const deleted = await deleteTwilioContent(config, template.twilio_content_sid);
    if (deleted) {
      console.log(`✅ Deleted from Twilio: ${template.twilio_content_sid}`);
    }
  }

  // Soft delete no banco
  const { error } = await supabase
    .from('whatsapp_templates')
    .update({
      is_active: false,
      updated_at: new Date().toISOString(),
    })
    .eq('organization_id', organizationId)
    .eq('id', templateId);

  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`);
  }

  console.log(`✅ Template deleted: ${templateId}`);
}

// ===========================
// APPROVAL API
// ===========================

/**
 * Submete um template para aprovação do WhatsApp
 * POST https://content.twilio.com/v1/Content/{sid}/ApprovalRequests/whatsapp
 */
export async function submitForApproval(
  organizationId: string,
  templateId: string,
  category?: string
): Promise<{ status: string; message: string }> {
  console.log(`📤 Submitting template ${templateId} for approval`);

  const template = await getTemplate(organizationId, templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  try {
    const response = await fetch(
      `${TWILIO_CONTENT_API_BASE}/Content/${template.twilio_content_sid}/ApprovalRequests/whatsapp`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': getAuthHeader(config),
        },
        body: JSON.stringify({
          name: template.friendly_name,
          category: category || template.category || 'UTILITY',
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `Failed to submit: ${response.status}`);
    }

    // Atualizar status no banco
    await supabase
      .from('whatsapp_templates')
      .update({
        status: 'pending',
        category: category || template.category,
        updated_at: new Date().toISOString(),
      })
      .eq('id', templateId);

    console.log(`✅ Template submitted for approval: ${templateId}`);
    return { status: 'submitted', message: 'Template submitted for WhatsApp approval' };

  } catch (error: any) {
    console.error('❌ Error submitting for approval:', error);
    throw new Error(`Failed to submit for approval: ${error.message}`);
  }
}

/**
 * Busca status de aprovação de um template
 * GET https://content.twilio.com/v1/Content/{sid}/ApprovalRequests
 */
export async function getApprovalStatus(
  organizationId: string,
  templateId: string
): Promise<{ status: string; rejection_reason?: string }> {
  const template = await getTemplate(organizationId, templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  try {
    const response = await fetch(
      `${TWILIO_CONTENT_API_BASE}/Content/${template.twilio_content_sid}/ApprovalRequests`,
      {
        method: 'GET',
        headers: {
          'Authorization': getAuthHeader(config),
        },
      }
    );

    if (!response.ok) {
      return { status: template.status, rejection_reason: template.rejection_reason };
    }

    const data = await response.json();
    const whatsappApproval = data.whatsapp;

    if (whatsappApproval) {
      const newStatus = whatsappApproval.status?.toLowerCase() || template.status;
      const rejectionReason = whatsappApproval.rejection_reason;

      if (newStatus !== template.status) {
        await supabase
          .from('whatsapp_templates')
          .update({
            status: newStatus,
            rejection_reason: rejectionReason,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', templateId);
      }

      return { status: newStatus, rejection_reason: rejectionReason };
    }

    return { status: template.status, rejection_reason: template.rejection_reason };

  } catch (error: any) {
    console.error('❌ Error getting approval status:', error);
    return { status: template.status, rejection_reason: template.rejection_reason };
  }
}

// ===========================
// SYNC OPERATIONS
// ===========================

/**
 * Lista todos os Content Templates do Twilio
 */
export async function listTemplatesFromTwilio(organizationId: string): Promise<any[]> {
  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  try {
    const contents = await listTwilioContents(config, 100);
    return contents.map(c => ({
      sid: c.sid,
      friendlyName: c.friendly_name,
      language: c.language,
      types: c.types,
      dateCreated: c.date_created,
      dateUpdated: c.date_updated,
    }));
  } catch (error: any) {
    console.error('❌ Error listing Twilio templates:', error);
    throw new Error(`Failed to list Twilio templates: ${error.message}`);
  }
}

/**
 * Sincroniza templates do Twilio com o banco de dados
 */
export async function syncAllTemplates(organizationId: string): Promise<{
  synced: number;
  added: number;
  updated: number;
}> {
  console.log(`🔄 Syncing templates for org: ${organizationId}`);

  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  let synced = 0;
  let added = 0;
  let updated = 0;

  try {
    // 1. Buscar todos os Content do Twilio via HTTP
    const twilioContents = await listTwilioContents(config, 100);

    // 2. Para cada content, verificar se existe no banco e atualizar
    for (const content of twilioContents) {
      const { data: existing } = await supabase
        .from('whatsapp_templates')
        .select('id')
        .eq('organization_id', organizationId)
        .eq('twilio_content_sid', content.sid)
        .single();

      // Buscar status de aprovação
      let approvalStatus = 'not_submitted';
      let rejectionReason: string | undefined;

      try {
        const approvalResponse = await fetch(
          `${TWILIO_CONTENT_API_BASE}/Content/${content.sid}/ApprovalRequests`,
          {
            method: 'GET',
            headers: {
              'Authorization': getAuthHeader(config),
            },
          }
        );

        if (approvalResponse.ok) {
          const approvalData = await approvalResponse.json();
          if (approvalData.whatsapp) {
            approvalStatus = approvalData.whatsapp.status?.toLowerCase() || 'not_submitted';
            rejectionReason = approvalData.whatsapp.rejection_reason;
          }
        }
      } catch (e) {
        // Ignorar erro de approval
      }

      // Extrair body do content
      const contentTypes = content.types as Record<string, any>;
      const body = contentTypes?.['twilio/text']?.body ||
                   contentTypes?.['twilio/quick-reply']?.body ||
                   contentTypes?.['twilio/call-to-action']?.body ||
                   contentTypes?.['twilio/list-picker']?.body ||
                   '';

      // Determinar tipo
      let templateType = 'text';
      if (contentTypes?.['twilio/quick-reply']) templateType = 'quick-reply';
      else if (contentTypes?.['twilio/call-to-action']) templateType = 'call-to-action';
      else if (contentTypes?.['twilio/list-picker']) templateType = 'list-picker';
      else if (contentTypes?.['twilio/media']) templateType = 'media';

      // Detectar origem do template (user, twilio_sample, twilio_tryout)
      const templateSource = detectTemplateSource(content.friendly_name);

      // Templates de sample/tryout NÃO devem ser marcados como "approved"
      // mesmo que a Twilio retorne esse status (são templates de sandbox)
      let finalStatus = approvalStatus;
      if (templateSource !== 'user' && approvalStatus === 'approved') {
        finalStatus = 'sample'; // Status especial para templates de amostra
      }

      if (existing) {
        await supabase
          .from('whatsapp_templates')
          .update({
            status: finalStatus,
            rejection_reason: rejectionReason,
            source: templateSource,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);
        updated++;
      } else {
        await supabase
          .from('whatsapp_templates')
          .insert({
            organization_id: organizationId,
            twilio_content_sid: content.sid,
            friendly_name: content.friendly_name || `template_${content.sid}`,
            language: content.language || 'pt_BR',
            template_type: templateType,
            body: body,
            status: finalStatus,
            rejection_reason: rejectionReason,
            source: templateSource,
            is_active: true,
            last_synced_at: new Date().toISOString(),
          });
        added++;
      }

      synced++;
    }

    console.log(`✅ Sync complete: ${synced} synced, ${added} added, ${updated} updated`);
    return { synced, added, updated };

  } catch (error: any) {
    console.error('❌ Error syncing templates:', error);
    throw new Error(`Failed to sync templates: ${error.message}`);
  }
}

// ===========================
// MESSAGE SENDING (usa SDK)
// ===========================

/**
 * Envia uma mensagem usando um template
 * NOTA: Esta função usa o SDK do Twilio (client.messages.create)
 */
export async function sendTemplateMessage(
  organizationId: string,
  input: SendMessageInput
): Promise<{ messageId: string; whatsappSid: string }> {
  console.log(`📤 Sending template message to ${input.to}`);

  const template = await getTemplate(organizationId, input.template_id);
  if (!template) {
    throw new Error('Template not found');
  }

  if (!template.is_active) {
    throw new Error('Template is not active');
  }

  // Usar SDK do Twilio para enviar mensagens
  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { client, config } = twilioData;

  const to = input.to.startsWith('whatsapp:') ? input.to : `whatsapp:${input.to}`;
  const from = config.whatsapp_number.startsWith('whatsapp:')
    ? config.whatsapp_number
    : `whatsapp:${config.whatsapp_number}`;

  let contentVariables: Record<string, string> | undefined;
  if (input.variables && Object.keys(input.variables).length > 0) {
    contentVariables = input.variables;
  }

  try {
    // Criar mensagem no banco primeiro
    const { data: savedMessage, error: msgError } = await supabase
      .from('messages')
      .insert({
        organization_id: organizationId,
        thread_id: input.thread_id,
        direction: 'outbound',
        content: template.body,
        template_id: template.id,
        sender_type: 'agent',
        whatsapp_status: 'sending',
      })
      .select('id')
      .single();

    if (msgError || !savedMessage) {
      throw new Error(`Failed to save message: ${msgError?.message}`);
    }

    // Enviar via Twilio SDK
    const messageOptions: any = {
      contentSid: template.twilio_content_sid,
      from,
      to,
      statusCallback: `${env.SUPABASE_URL}/functions/v1/twilio-status-webhook?orgId=${organizationId}`,
    };

    if (contentVariables) {
      messageOptions.contentVariables = JSON.stringify(contentVariables);
    }

    const twilioMessage = await client.messages.create(messageOptions);

    // Atualizar mensagem com SID
    await supabase
      .from('messages')
      .update({
        whatsapp_message_sid: twilioMessage.sid,
        whatsapp_status: 'sent',
        sent_at: new Date().toISOString(),
      })
      .eq('id', savedMessage.id);

    console.log(`✅ Template message sent: ${twilioMessage.sid}`);
    return { messageId: savedMessage.id, whatsappSid: twilioMessage.sid };

  } catch (error: any) {
    console.error('❌ Error sending template message:', error);
    throw new Error(`Failed to send template message: ${error.message}`);
  }
}

/**
 * Deleta um Content Template diretamente do Twilio (sem afetar o banco)
 */
export async function deleteTemplateFromTwilio(
  organizationId: string,
  contentSid: string
): Promise<boolean> {
  const config = await getWhatsAppConfig(organizationId);
  if (!config) {
    throw new Error('WhatsApp integration not configured');
  }

  const deleted = await deleteTwilioContent(config, contentSid);
  if (deleted) {
    console.log(`✅ Deleted from Twilio: ${contentSid}`);
  }
  return deleted;
}
