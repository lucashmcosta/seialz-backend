import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Cliente Supabase com Service Role Key (acesso total)
export const supabase = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

// Tipos das tabelas (baseado no schema do Lucas)
export interface MessageThread {
  id: string;
  organization_id: string;
  contact_id: string;
  opportunity_id?: string;
  channel: string;
  subject?: string;
  external_id?: string;
  needs_human_attention: boolean;
  whatsapp_last_inbound_at?: string;
  agent_typing?: boolean;
  agent_typing_at?: string;
  awaiting_button_response?: boolean;
  button_options?: QuickReplyButton[];
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  organization_id: string;
  thread_id: string;
  sender_user_id?: string;
  sender_agent_id?: string;
  sender_type: 'user' | 'agent' | 'contact';
  sender_name?: string;
  direction: 'inbound' | 'outbound' | 'internal';
  content: string;
  template_id?: string;
  reply_to_message_id?: string;
  whatsapp_message_sid?: string;
  whatsapp_status?: string;
  media_type?: string;
  media_urls?: string[];
  error_code?: string;
  error_message?: string;
  ai_processed?: boolean;
  metadata?: Record<string, unknown>;
  sent_at?: string;
  created_at: string;
  deleted_at?: string;
}

export interface Contact {
  id: string;
  organization_id: string;
  phone?: string;
  email?: string;
  first_name?: string;
  last_name?: string;
}

export interface Organization {
  id: string;
  name: string;
  twilio_account_sid?: string;
  twilio_auth_token?: string;
  whatsapp_phone_number?: string;
  anthropic_api_key?: string;
  voyage_api_key?: string;
  openai_api_key?: string;
}

export interface AIAgent {
  id: string;
  organization_id: string;
  name: string;
  is_enabled: boolean;
  system_prompt?: string;
}

export interface QuickReplyButton {
  id: string;
  title: string;
}
