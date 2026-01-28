// src/services/twilio-whatsapp-templates.ts
// Serviço para gerenciar WhatsApp Business Message Templates via Twilio Content API

import twilio from 'twilio';
import type { Twilio } from 'twilio';
import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';
import type { TemplateVariable, TemplateButton, TemplateAction } from '../lib/template-validation.js';

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

// ===========================
// HELPERS
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
 * Cria cliente Twilio para uma organização
 */
async function getTwilioClient(organizationId: string): Promise<{ client: Twilio; config: WhatsAppConfig } | null> {
  const config = await getWhatsAppConfig(organizationId);
  if (!config) return null;

  const client = twilio(config.account_sid, config.auth_token);
  return { client, config };
}

/**
 * Constrói o payload para a Twilio Content API baseado no tipo de template
 */
function buildTwilioContentPayload(data: CreateTemplateInput): object {
  const baseTypes: Record<string, object> = {
    // Sempre incluir fallback de texto
    twilioText: {
      body: data.body,
    },
  };

  switch (data.template_type) {
    case 'text':
      // Apenas texto simples
      break;

    case 'quick-reply':
      if (data.buttons && data.buttons.length > 0) {
        baseTypes.twilioQuickReply = {
          body: data.body,
          actions: data.buttons.map(btn => ({
            type: 'QUICK_REPLY',
            title: btn.title,
            id: btn.id,
          })),
        };
      }
      break;

    case 'call-to-action':
      if (data.actions && data.actions.length > 0) {
        baseTypes.twilioCallToAction = {
          body: data.body,
          actions: data.actions
            .filter(a => a.type === 'url' || a.type === 'phone')
            .map(action => {
              if (action.type === 'url') {
                return {
                  type: 'URL',
                  title: action.title,
                  url: action.url,
                };
              } else {
                return {
                  type: 'PHONE_NUMBER',
                  title: action.title,
                  phone: action.phone,
                };
              }
            }),
        };
      }
      break;

    case 'list-picker':
      if (data.actions && data.actions.length > 0) {
        const listItems = data.actions.filter(a => a.type === 'list_item');
        baseTypes.twilioListPicker = {
          body: data.body,
          button: 'Ver opções',
          items: listItems.map((item, index) => ({
            id: `item_${index}`,
            item: item.title,
            description: item.description,
          })),
        };
      }
      break;

    case 'media':
      // Media templates são tratados de forma diferente
      // Por enquanto, usamos apenas o texto
      break;
  }

  return {
    friendlyName: data.friendly_name,
    language: data.language || 'pt_BR',
    types: baseTypes,
    // Incluir variáveis se existirem
    ...(data.variables && data.variables.length > 0 && {
      variables: data.variables.reduce((acc, v) => {
        acc[v.key] = v.example;
        return acc;
      }, {} as Record<string, string>),
    }),
  };
}

// ===========================
// DATABASE OPERATIONS
// ===========================

/**
 * Lista templates de uma organização
 */
export async function listTemplates(
  organizationId: string,
  filters?: {
    status?: string;
    template_type?: string;
    is_active?: boolean;
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
    if (error.code === 'PGRST116') return null; // Not found
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

  // Converter buttons para ações
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

  // Converter actions
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

  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { client } = twilioData;

  try {
    // 1. Criar no Twilio Content API
    const payload = buildTwilioContentPayload(data);
    const content = await client.content.v1.contents.create(payload as any);

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
        status: 'pending',
        category: data.category,
        is_active: true,
      })
      .select()
      .single();

    if (error || !template) {
      // Rollback: deletar do Twilio
      await client.content.v1.contents(content.sid).remove();
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

  // 1. Buscar template existente
  const existing = await getTemplate(organizationId, templateId);
  if (!existing) {
    throw new Error('Template not found');
  }

  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { client } = twilioData;

  try {
    // 2. Deletar o Content antigo do Twilio
    if (existing.twilio_content_sid) {
      try {
        await client.content.v1.contents(existing.twilio_content_sid).remove();
        console.log(`🗑️ Deleted old Twilio content: ${existing.twilio_content_sid}`);
      } catch (e) {
        console.warn('⚠️ Could not delete old Twilio content:', e);
      }
    }

    // 3. Criar novo Content no Twilio com dados mesclados
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
    const content = await client.content.v1.contents.create(payload as any);

    console.log(`✅ Created new Twilio content: ${content.sid}`);

    // 4. Atualizar no banco
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
        status: 'pending', // Reset status após edição
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', organizationId)
      .eq('id', templateId)
      .select()
      .single();

    if (error || !template) {
      throw new Error(`Failed to update template: ${error?.message}`);
    }

    // 5. Atualizar ações
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

  // 1. Buscar template
  const template = await getTemplate(organizationId, templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  const twilioData = await getTwilioClient(organizationId);

  // 2. Deletar do Twilio (se configurado)
  if (twilioData && template.twilio_content_sid) {
    try {
      await twilioData.client.content.v1.contents(template.twilio_content_sid).remove();
      console.log(`✅ Deleted from Twilio: ${template.twilio_content_sid}`);
    } catch (e) {
      console.warn('⚠️ Could not delete from Twilio:', e);
    }
  }

  // 3. Soft delete no banco
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

  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { config } = twilioData;

  try {
    // Twilio Content API - Submit for approval
    const response = await fetch(
      `https://content.twilio.com/v1/Content/${template.twilio_content_sid}/ApprovalRequests/whatsapp`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64'),
        },
        body: JSON.stringify({
          name: template.friendly_name,
          category: category || template.category || 'UTILITY',
        }),
      }
    );

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Failed to submit for approval');
    }

    const data = await response.json();

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
 */
export async function getApprovalStatus(
  organizationId: string,
  templateId: string
): Promise<{ status: string; rejection_reason?: string }> {
  const template = await getTemplate(organizationId, templateId);
  if (!template) {
    throw new Error('Template not found');
  }

  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { config } = twilioData;

  try {
    const response = await fetch(
      `https://content.twilio.com/v1/Content/${template.twilio_content_sid}/ApprovalRequests`,
      {
        method: 'GET',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64'),
        },
      }
    );

    if (!response.ok) {
      // Se não há approval request, retornar status atual
      return { status: template.status, rejection_reason: template.rejection_reason };
    }

    const data = await response.json();
    const whatsappApproval = data.whatsapp;

    if (whatsappApproval) {
      const newStatus = whatsappApproval.status?.toLowerCase() || template.status;
      const rejectionReason = whatsappApproval.rejection_reason;

      // Atualizar no banco se mudou
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
  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { client } = twilioData;

  try {
    const contents = await client.content.v1.contents.list({ limit: 100 });
    return contents.map(c => ({
      sid: c.sid,
      friendlyName: c.friendlyName,
      language: c.language,
      types: c.types,
      dateCreated: c.dateCreated,
      dateUpdated: c.dateUpdated,
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

  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { client, config } = twilioData;

  let synced = 0;
  let added = 0;
  let updated = 0;

  try {
    // 1. Buscar todos os Content do Twilio
    const twilioContents = await client.content.v1.contents.list({ limit: 100 });

    // 2. Para cada content, verificar se existe no banco e atualizar
    for (const content of twilioContents) {
      // Buscar template existente pelo SID
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
          `https://content.twilio.com/v1/Content/${content.sid}/ApprovalRequests`,
          {
            method: 'GET',
            headers: {
              'Authorization': 'Basic ' + Buffer.from(`${config.account_sid}:${config.auth_token}`).toString('base64'),
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
      const body = contentTypes?.twilioText?.body ||
                   contentTypes?.twilioQuickReply?.body ||
                   contentTypes?.twilioCallToAction?.body ||
                   contentTypes?.twilioListPicker?.body ||
                   '';

      // Determinar tipo
      let templateType = 'text';
      if (contentTypes?.twilioQuickReply) templateType = 'quick-reply';
      else if (contentTypes?.twilioCallToAction) templateType = 'call-to-action';
      else if (contentTypes?.twilioListPicker) templateType = 'list-picker';
      else if (contentTypes?.twilioMedia) templateType = 'media';

      if (existing) {
        // Atualizar existente
        await supabase
          .from('whatsapp_templates')
          .update({
            status: approvalStatus,
            rejection_reason: rejectionReason,
            last_synced_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', existing.id);

        updated++;
      } else {
        // Criar novo
        await supabase
          .from('whatsapp_templates')
          .insert({
            organization_id: organizationId,
            twilio_content_sid: content.sid,
            friendly_name: content.friendlyName || `template_${content.sid}`,
            language: content.language || 'pt_BR',
            template_type: templateType,
            body: body,
            status: approvalStatus,
            rejection_reason: rejectionReason,
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
// MESSAGE SENDING
// ===========================

/**
 * Envia uma mensagem usando um template
 */
export async function sendTemplateMessage(
  organizationId: string,
  input: SendMessageInput
): Promise<{ messageId: string; whatsappSid: string }> {
  console.log(`📤 Sending template message to ${input.to}`);

  // 1. Buscar template
  const template = await getTemplate(organizationId, input.template_id);
  if (!template) {
    throw new Error('Template not found');
  }

  if (!template.is_active) {
    throw new Error('Template is not active');
  }

  // 2. Buscar config do Twilio
  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  const { client, config } = twilioData;

  // 3. Formatar número
  const to = input.to.startsWith('whatsapp:') ? input.to : `whatsapp:${input.to}`;
  const from = config.whatsapp_number.startsWith('whatsapp:')
    ? config.whatsapp_number
    : `whatsapp:${config.whatsapp_number}`;

  // 4. Preparar variáveis de conteúdo
  let contentVariables: Record<string, string> | undefined;
  if (input.variables && Object.keys(input.variables).length > 0) {
    contentVariables = input.variables;
  }

  try {
    // 5. Criar mensagem no banco primeiro
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

    // 6. Enviar via Twilio
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

    // 7. Atualizar mensagem com SID
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
  const twilioData = await getTwilioClient(organizationId);
  if (!twilioData) {
    throw new Error('WhatsApp integration not configured');
  }

  try {
    await twilioData.client.content.v1.contents(contentSid).remove();
    console.log(`✅ Deleted from Twilio: ${contentSid}`);
    return true;
  } catch (error: any) {
    console.error('❌ Error deleting from Twilio:', error);
    return false;
  }
}
