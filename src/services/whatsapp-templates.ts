// src/services/whatsapp-templates.ts

import twilio from 'twilio';
import { supabase } from '../lib/supabase.js';

interface WhatsAppConfig {
  account_sid: string;
  auth_token: string;
  messaging_service_sid?: string;
  whatsapp_number: string;
}

interface Template {
  id: string;
  organization_id: string;
  name: string;
  body: string;
  category: string;
  status: string;
  twilio_content_sid?: string;
  created_at: string;
  updated_at: string;
}

interface CreateTemplateOptions {
  organizationId: string;
  name: string;
  body: string;
  category: 'MARKETING' | 'UTILITY';
}

interface SyncTemplatesOptions {
  organizationId: string;
}

// Get Twilio config for organization
async function getTwilioConfig(organizationId: string): Promise<WhatsAppConfig> {
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

  const config = integration.config_values as WhatsAppConfig;

  if (!config.account_sid || !config.auth_token) {
    throw new Error('Twilio credentials not configured');
  }

  return config;
}

// List templates for organization
export async function listTemplates(organizationId: string): Promise<Template[]> {
  const { data, error } = await supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false });

  if (error) {
    throw new Error(`Failed to list templates: ${error.message}`);
  }

  return data || [];
}

// Create a new template
export async function createTemplate(options: CreateTemplateOptions): Promise<Template> {
  const { organizationId, name, body, category } = options;

  // Try to create in Twilio Content API if credentials exist
  let twilioContentSid: string | undefined;

  try {
    const config = await getTwilioConfig(organizationId);
    const twilioClient = twilio(config.account_sid, config.auth_token);

    // Create content template in Twilio using Contents API
    const contentTemplate = await twilioClient.content.v1.contents.create({
      friendlyName: name,
      language: 'pt_BR',
      types: {
        'twilio/text': {
          body: body,
        },
      },
    } as any);

    twilioContentSid = contentTemplate.sid;
    console.log(`📝 Template created in Twilio: ${twilioContentSid}`);
  } catch (twilioError) {
    console.warn('⚠️ Could not create template in Twilio:', twilioError);
    // Continue without Twilio SID - template will be local only
  }

  // Save to database
  const { data, error } = await supabase
    .from('whatsapp_templates')
    .insert({
      organization_id: organizationId,
      name,
      body,
      category,
      status: twilioContentSid ? 'pending' : 'local',
      twilio_content_sid: twilioContentSid,
    })
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to create template: ${error.message}`);
  }

  return data;
}

// Delete a template
export async function deleteTemplate(
  templateId: string,
  organizationId: string
): Promise<void> {
  // Get template first
  const { data: template, error: fetchError } = await supabase
    .from('whatsapp_templates')
    .select('*')
    .eq('id', templateId)
    .eq('organization_id', organizationId)
    .single();

  if (fetchError || !template) {
    throw new Error('Template not found');
  }

  // Try to delete from Twilio if it has a content SID
  if (template.twilio_content_sid) {
    try {
      const config = await getTwilioConfig(organizationId);
      const twilioClient = twilio(config.account_sid, config.auth_token);

      await twilioClient.content.v1.contents(template.twilio_content_sid).remove();
      console.log(`🗑️ Template deleted from Twilio: ${template.twilio_content_sid}`);
    } catch (twilioError) {
      console.warn('⚠️ Could not delete template from Twilio:', twilioError);
      // Continue with local deletion
    }
  }

  // Delete from database
  const { error } = await supabase
    .from('whatsapp_templates')
    .delete()
    .eq('id', templateId)
    .eq('organization_id', organizationId);

  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`);
  }
}

// Sync templates from Twilio
export async function syncTemplates(options: SyncTemplatesOptions): Promise<{
  synced: number;
  templates: Template[];
}> {
  const { organizationId } = options;
  const config = await getTwilioConfig(organizationId);
  const twilioClient = twilio(config.account_sid, config.auth_token);

  // Fetch all content templates from Twilio
  const contentList = await twilioClient.content.v1.contents.list();

  console.log(`🔄 Found ${contentList.length} templates in Twilio`);

  let synced = 0;
  const templates: Template[] = [];

  for (const content of contentList) {
    // Check if template already exists
    const { data: existing } = await supabase
      .from('whatsapp_templates')
      .select('id')
      .eq('organization_id', organizationId)
      .eq('twilio_content_sid', content.sid)
      .single();

    // Cast content to any to access all properties (Twilio types are incomplete)
    const contentAny = content as any;

    if (existing) {
      // Update existing template
      const { data: updated, error: updateError } = await supabase
        .from('whatsapp_templates')
        .update({
          name: content.friendlyName,
          status: mapTwilioStatus(contentAny.approvalRequests),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (!updateError && updated) {
        templates.push(updated);
      }
    } else {
      // Create new template from Twilio
      const body = extractBodyFromContent(content);

      const { data: created, error: createError } = await supabase
        .from('whatsapp_templates')
        .insert({
          organization_id: organizationId,
          name: content.friendlyName,
          body: body,
          category: 'UTILITY',
          status: mapTwilioStatus(contentAny.approvalRequests),
          twilio_content_sid: content.sid,
        })
        .select()
        .single();

      if (!createError && created) {
        templates.push(created);
        synced++;
      }
    }
  }

  console.log(`✅ Synced ${synced} new templates`);

  return { synced, templates };
}

// Helper to map Twilio approval status
function mapTwilioStatus(approvalRequests: any): string {
  if (!approvalRequests) return 'pending';

  const statuses = Object.values(approvalRequests);
  if (statuses.some((s: any) => s?.status === 'approved')) return 'approved';
  if (statuses.some((s: any) => s?.status === 'rejected')) return 'rejected';
  return 'pending';
}

// Helper to extract body from Twilio content
function extractBodyFromContent(content: any): string {
  try {
    if (content.types?.['twilio/text']?.body) {
      return content.types['twilio/text'].body;
    }
    if (content.types?.['twilio/quick-reply']?.body) {
      return content.types['twilio/quick-reply'].body;
    }
    return '';
  } catch {
    return '';
  }
}
