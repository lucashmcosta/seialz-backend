import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { serve } from 'inngest/fastify';
import { env } from './config/env.js';
import { inngest } from './lib/inngest.js';
import { twilioWebhookRoutes } from './webhooks/twilio.js';
import { processMessageBatch } from './inngest/functions/process-message-batch.js';

// Criar servidor Fastify
const app = Fastify({
  logger: true,
});

// Plugins
await app.register(cors, {
  origin: true, // Permitir todas as origens (ajustar em produção)
});

await app.register(formbody); // Para parsear form-data do Twilio

// ===========================
// ROTAS DE HEALTH CHECK
// ===========================

app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

app.get('/', async () => {
  return { 
    name: 'Seialz Backend',
    version: '1.0.0',
    status: 'running',
  };
});

// ===========================
// WEBHOOKS
// ===========================

// Twilio WhatsApp
await twilioWebhookRoutes(app);

// ===========================
// INNGEST
// ===========================

// Endpoint para Inngest processar funções
app.route({
  method: ['GET', 'POST', 'PUT'],
  url: '/api/inngest',
  handler: serve({
    client: inngest,
    functions: [
      processMessageBatch,
      // Adicionar mais funções aqui conforme necessário
    ],
  }),
});

// ===========================
// INICIAR SERVIDOR
// ===========================

const start = async () => {
  try {
    await app.listen({ 
      port: env.PORT, 
      host: '0.0.0.0' // Importante para Railway
    });
    
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   🚀 SEIALZ BACKEND RUNNING                               ║
║                                                           ║
║   Server:   http://localhost:${env.PORT}                       ║
║   Health:   http://localhost:${env.PORT}/health                ║
║   Inngest:  http://localhost:${env.PORT}/api/inngest           ║
║                                                           ║
║   Webhooks:                                               ║
║   - Twilio: POST /webhook/twilio/whatsapp                 ║
║   - Status: POST /webhook/twilio/status                   ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
