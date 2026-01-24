// src/services/whatsapp-setup.ts

import twilio from 'twilio';
import { supabase } from '../lib/supabase.js';

interface SetupOptions {
  organizationId: string;
  accountSid: string;
  authToken: string;
  whatsappNumber: string;
  messagingServiceSid?: string;
}

interface SetupResult {
  success: boolean;
  integrationId: string;
  webhookUrl?: string;
  error?: string;
}

// Validate Twilio credentials
async function validateTwilioCredentials(
  accountSid: string,
  authToken: string
): Promise<boolean> {
  try {
    const client = twilio(accountSid, authToken);
    // Try to fetch account info to validate credentials
    const account = await client.api.accounts(accountSid).fetch();
    return account.status === 'active';
  } catch (error) {
    console.error('❌ Invalid Twilio credentials:', error);
    return false;
  }
}

// Format phone number to E.164
function formatPhoneNumber(phone: string): string {
  // Remove all non-digit characters except +
  let cleaned = phone.replace(/[^\d+]/g, '');

  // Ensure it starts with +
  if (!cleaned.startsWith('+')) {
    cleaned = '+' + cleaned;
  }

  return cleaned;
}

// Setup WhatsApp integration for organization
export async function setupWhatsAppIntegration(
  options: SetupOptions
): Promise<SetupResult> {
  const { organizationId, accountSid, authToken, whatsappNumber, messagingServiceSid } = options;

  console.log(`🔧 Setting up WhatsApp integration for org: ${organizationId}`);

  // 1. Validate Twilio credentials
  const isValid = await validateTwilioCredentials(accountSid, authToken);
  if (!isValid) {
    return {
      success: false,
      integrationId: '',
      error: 'Invalid Twilio credentials. Please verify your Account SID and Auth Token.',
    };
  }

  console.log('✅ Twilio credentials validated');

  // 2. Get the admin integration ID for twilio-whatsapp
  const { data: adminIntegration, error: adminError } = await supabase
    .from('admin_integrations')
    .select('id')
    .eq('slug', 'twilio-whatsapp')
    .single();

  if (adminError || !adminIntegration) {
    // Create the admin integration if it doesn't exist
    const { data: newAdminIntegration, error: createAdminError } = await supabase
      .from('admin_integrations')
      .insert({
        name: 'Twilio WhatsApp',
        slug: 'twilio-whatsapp',
        description: 'WhatsApp Business API via Twilio',
        category: 'messaging',
        is_available: true,
      })
      .select('id')
      .single();

    if (createAdminError || !newAdminIntegration) {
      return {
        success: false,
        integrationId: '',
        error: 'Failed to create admin integration configuration',
      };
    }

    console.log('📝 Created admin integration for twilio-whatsapp');
  }

  const adminIntegrationId = adminIntegration?.id || (await supabase
    .from('admin_integrations')
    .select('id')
    .eq('slug', 'twilio-whatsapp')
    .single()).data?.id;

  if (!adminIntegrationId) {
    return {
      success: false,
      integrationId: '',
      error: 'Failed to get admin integration ID',
    };
  }

  // 3. Create or update organization integration
  const configValues = {
    account_sid: accountSid,
    auth_token: authToken,
    whatsapp_number: formatPhoneNumber(whatsappNumber),
    messaging_service_sid: messagingServiceSid || null,
  };

  // Check if integration already exists
  const { data: existingIntegration } = await supabase
    .from('organization_integrations')
    .select('id')
    .eq('organization_id', organizationId)
    .eq('admin_integration_id', adminIntegrationId)
    .single();

  let integrationId: string;

  if (existingIntegration) {
    // Update existing
    const { data: updated, error: updateError } = await supabase
      .from('organization_integrations')
      .update({
        config_values: configValues,
        is_enabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existingIntegration.id)
      .select('id')
      .single();

    if (updateError || !updated) {
      return {
        success: false,
        integrationId: '',
        error: `Failed to update integration: ${updateError?.message}`,
      };
    }

    integrationId = updated.id;
    console.log('🔄 Updated existing integration');
  } else {
    // Create new
    const { data: created, error: createError } = await supabase
      .from('organization_integrations')
      .insert({
        organization_id: organizationId,
        admin_integration_id: adminIntegrationId,
        config_values: configValues,
        is_enabled: true,
      })
      .select('id')
      .single();

    if (createError || !created) {
      return {
        success: false,
        integrationId: '',
        error: `Failed to create integration: ${createError?.message}`,
      };
    }

    integrationId = created.id;
    console.log('✨ Created new integration');
  }

  // 4. Build webhook URL (for documentation purposes)
  // The actual webhook URL depends on the deployment environment
  const webhookUrl = `/webhook/twilio/whatsapp?orgId=${organizationId}`;

  console.log(`✅ WhatsApp integration setup complete`);
  console.log(`📞 WhatsApp Number: ${formatPhoneNumber(whatsappNumber)}`);
  console.log(`🔗 Webhook URL: ${webhookUrl}`);

  return {
    success: true,
    integrationId,
    webhookUrl,
  };
}

// Get integration status
export async function getIntegrationStatus(organizationId: string): Promise<{
  configured: boolean;
  enabled: boolean;
  whatsappNumber?: string;
}> {
  const { data: integration, error } = await supabase
    .from('organization_integrations')
    .select(`
      is_enabled,
      config_values,
      admin_integrations!inner(slug)
    `)
    .eq('organization_id', organizationId)
    .eq('admin_integrations.slug', 'twilio-whatsapp')
    .single();

  if (error || !integration) {
    return { configured: false, enabled: false };
  }

  const config = integration.config_values as { whatsapp_number?: string };

  return {
    configured: true,
    enabled: integration.is_enabled,
    whatsappNumber: config?.whatsapp_number,
  };
}
