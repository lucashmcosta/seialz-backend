// src/middleware/auth.ts

import { FastifyRequest, FastifyReply } from 'fastify';
import { createClient, User } from '@supabase/supabase-js';
import { env } from '../config/env.js';

// Extend FastifyRequest to include user
declare module 'fastify' {
  interface FastifyRequest {
    user: User;
  }
}

// Create a separate Supabase client for auth validation
const supabaseAuth = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  }
);

export async function validateAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Unauthorized', message: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);

    if (error || !user) {
      reply.status(401).send({ error: 'Unauthorized', message: 'Invalid token' });
      return;
    }

    request.user = user;
  } catch (err) {
    request.log.error({ err }, 'Auth validation error');
    reply.status(401).send({ error: 'Unauthorized', message: 'Token validation failed' });
    return;
  }
}

// Helper to validate organization membership
export async function validateOrganizationAccess(
  userId: string,
  organizationId: string
): Promise<boolean> {
  const { data, error } = await supabaseAuth
    .from('organization_members')
    .select('id')
    .eq('user_id', userId)
    .eq('organization_id', organizationId)
    .single();

  return !error && !!data;
}
