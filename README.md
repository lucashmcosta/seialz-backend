# Seialz Backend

Backend Node.js para o CRM Seialz - WhatsApp AI Agent com Inngest.

## Stack

- **Runtime:** Node.js 20+
- **Framework:** Fastify
- **Linguagem:** TypeScript
- **Database:** Supabase (PostgreSQL)
- **Filas/Workflows:** Inngest
- **WhatsApp:** Twilio
- **AI:** Claude (Anthropic)

## Arquitetura

```
┌─────────────────────────────────────────────────────────────┐
│                    SEIALZ BACKEND                           │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  LOVABLE (Frontend)                                         │
│       │                                                     │
│       ▼                                                     │
│  SUPABASE (Database, Auth, Realtime)                        │
│       │                                                     │
│       ▼                                                     │
│  ESTE BACKEND (Node.js + Fastify)                          │
│  ├── Webhooks (Twilio)                                     │
│  ├── Inngest (Message Batching)                            │
│  └── AI Agent (Claude)                                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Setup Local

### 1. Instalar dependências

```bash
npm install
```

### 2. Configurar variáveis de ambiente

```bash
cp .env.example .env
# Editar .env com suas credenciais
```

### 3. Rodar em desenvolvimento

```bash
# Terminal 1: Servidor
npm run dev

# Terminal 2: Inngest Dev Server
npm run inngest-dev
```

### 4. Testar

```bash
curl http://localhost:3000/health
```

## Deploy no Railway

### 1. Conectar repositório

1. Vá em [Railway](https://railway.app)
2. Conecte seu repositório GitHub
3. Railway detecta automaticamente Node.js

### 2. Configurar variáveis de ambiente

No Railway, vá em "Variables" e adicione:

```
PORT=3000
NODE_ENV=production
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
INNGEST_EVENT_KEY=...
INNGEST_SIGNING_KEY=...
```

### 3. Deploy

Railway faz deploy automático a cada push no GitHub.

## Configurar Inngest

### 1. Criar conta

1. Vá em [inngest.com](https://inngest.com)
2. Crie uma conta (free tier: 25k eventos/mês)
3. Crie um app

### 2. Configurar endpoint

No Inngest Dashboard:
- URL: `https://seu-backend.railway.app/api/inngest`
- Copie Event Key e Signing Key para as variáveis

## Configurar Twilio

### 1. Webhook URL

No Twilio Console, configure o webhook do WhatsApp:
- URL: `https://seu-backend.railway.app/webhook/twilio/whatsapp`
- Method: POST

### 2. Status Callback

Para receber status de entrega:
- URL: `https://seu-backend.railway.app/webhook/twilio/status`
- Method: POST

## Estrutura de Pastas

```
src/
├── index.ts              # Entry point (Fastify)
├── config/
│   └── env.ts            # Variáveis de ambiente
├── lib/
│   ├── supabase.ts       # Cliente Supabase
│   └── inngest.ts        # Cliente Inngest
├── webhooks/
│   └── twilio.ts         # Webhook WhatsApp
├── inngest/
│   └── functions/
│       └── process-message-batch.ts
└── services/
    ├── ai-agent.ts       # Lógica do agente
    └── whatsapp.ts       # Envio de mensagens
```

## Funções Inngest

### process-message-batch

Processa mensagens com debounce de 5 segundos.

```typescript
// Quando cliente manda várias mensagens:
// 1. Primeira mensagem → Inngest agenda para 5s
// 2. Segunda mensagem → Inngest reseta timer
// 3. 5s sem mensagem → Processa batch
```

## Migrations Necessárias (Supabase)

Execute no SQL Editor do Supabase:

```sql
-- Campo para saber se mensagem foi processada
ALTER TABLE messages 
ADD COLUMN IF NOT EXISTS ai_processed BOOLEAN DEFAULT false;

-- Campos para typing e botões
ALTER TABLE message_threads 
ADD COLUMN IF NOT EXISTS agent_typing BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS agent_typing_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS awaiting_button_response BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS button_options JSONB;

-- Índice para buscar mensagens pendentes
CREATE INDEX IF NOT EXISTS idx_messages_ai_pending 
ON messages(organization_id, thread_id, direction, ai_processed) 
WHERE direction = 'inbound' AND ai_processed = false;
```

## TODO

- [ ] Migrar lógica completa do ai-agent-respond
- [ ] Implementar RAG (busca de conhecimento)
- [ ] Adicionar transcrição de áudio
- [ ] Adicionar webhook Gupshup
- [ ] Implementar follow-up automático

## Suporte

Lucas - Divus Legal Group / XLC Capital
