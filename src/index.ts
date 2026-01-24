import Fastify from 'fastify';
import cors from '@fastify/cors';
import formbody from '@fastify/formbody';
import { serve } from 'inngest/fastify';
import { env } from './config/env.js';
import { inngest } from './lib/inngest.js';
import { twilioWebhookRoutes } from './webhooks/twilio.js';
import { whatsappRoutes } from './routes/whatsapp.js';
import { processMessageBatch } from './inngest/functions/process-message-batch.js';

// Criar servidor Fastify
const app = Fastify({
  logger: true,
});

// Plugins
await app.register(cors, {
  origin: [
    // Production Lovable apps
    /\.lovable\.app$/,
    /\.lovableproject\.com$/,
    // Local development
    'http://localhost:5173',
    'http://localhost:3000',
    'http://localhost:3001',
    // Allow all in development (fallback)
    ...(env.NODE_ENV === 'development' ? [true] : []),
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
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
// API ROUTES
// ===========================

// WhatsApp API routes (authenticated)
await whatsappRoutes(app);

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
║   WhatsApp API (authenticated):                           ║
║   - POST /api/whatsapp/send                               ║
║   - GET  /api/whatsapp/templates                          ║
║   - POST /api/whatsapp/templates                          ║
║   - DELETE /api/whatsapp/templates/:id                    ║
║   - POST /api/whatsapp/templates/sync                     ║
║   - POST /api/whatsapp/setup                              ║
║   - GET  /api/whatsapp/status                             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
    
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
