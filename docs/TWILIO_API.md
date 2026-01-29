# Twilio API - Guia de Integração

Este documento descreve como usar as APIs do Twilio neste projeto.

## Visão Geral

O Twilio oferece duas formas de interação:

1. **SDK do Twilio** - Para enviar mensagens
2. **Content API (HTTP direto)** - Para gerenciar templates

**IMPORTANTE**: O SDK do Twilio NÃO suporta a Content API para criar/gerenciar templates.
A Content API deve ser acessada via HTTP direto (fetch).

---

## SDK do Twilio (client.messages.create)

### Quando usar
- **Enviar mensagens** de texto ou com templates

### Instalação
```bash
npm install twilio
```

### Uso
```typescript
import twilio from 'twilio';

const client = twilio(accountSid, authToken);

// Enviar mensagem de texto
await client.messages.create({
  body: 'Hello World',
  from: 'whatsapp:+14155238886',
  to: 'whatsapp:+5511999999999',
});

// Enviar mensagem com template (Content Template)
await client.messages.create({
  contentSid: 'HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',  // Content SID
  from: 'whatsapp:+14155238886',
  to: 'whatsapp:+5511999999999',
  contentVariables: JSON.stringify({
    "1": "João",
    "2": "12345"
  }),
  statusCallback: 'https://seu-backend.com/webhook/twilio/status',
});
```

### Parâmetros importantes
| Parâmetro | Descrição |
|-----------|-----------|
| `contentSid` | SID do Content Template (HX...) |
| `from` | Número de origem (whatsapp:+...) |
| `to` | Número de destino (whatsapp:+...) |
| `contentVariables` | JSON string com variáveis do template |
| `statusCallback` | URL para receber atualizações de status |

---

## Content API (HTTP direto)

### Base URL
```
https://content.twilio.com/v1
```

### Autenticação
```
Authorization: Basic base64(accountSid:authToken)
```

### Endpoints

#### 1. Criar Template
```http
POST /v1/Content
Content-Type: application/json
Authorization: Basic {base64}

{
  "friendly_name": "meu_template_teste",
  "language": "pt_BR",
  "variables": {
    "1": "exemplo_nome",
    "2": "exemplo_pedido"
  },
  "types": {
    "twilio/text": {
      "body": "Olá {{1}}, seu pedido {{2}} está pronto!"
    }
  }
}
```

**Resposta:**
```json
{
  "sid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "friendly_name": "meu_template_teste",
  "language": "pt_BR",
  "types": { ... },
  "date_created": "2024-01-15T10:30:00Z",
  "date_updated": "2024-01-15T10:30:00Z"
}
```

#### 2. Listar Templates
```http
GET /v1/Content?PageSize=100
Authorization: Basic {base64}
```

**Resposta:**
```json
{
  "contents": [
    {
      "sid": "HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "friendly_name": "meu_template",
      "language": "pt_BR",
      "types": { ... }
    }
  ]
}
```

#### 3. Buscar Template
```http
GET /v1/Content/{sid}
Authorization: Basic {base64}
```

#### 4. Deletar Template
```http
DELETE /v1/Content/{sid}
Authorization: Basic {base64}
```

**Resposta:** `204 No Content`

#### 5. Submeter para Aprovação WhatsApp
```http
POST /v1/Content/{sid}/ApprovalRequests/whatsapp
Content-Type: application/json
Authorization: Basic {base64}

{
  "name": "meu_template_teste",
  "category": "UTILITY"
}
```

**Categorias válidas:**
- `UTILITY` - Mensagens transacionais
- `MARKETING` - Mensagens promocionais
- `AUTHENTICATION` - Códigos de verificação

#### 6. Ver Status de Aprovação
```http
GET /v1/Content/{sid}/ApprovalRequests
Authorization: Basic {base64}
```

**Resposta:**
```json
{
  "whatsapp": {
    "status": "approved",
    "rejection_reason": null
  }
}
```

**Status possíveis:**
- `pending` - Aguardando aprovação
- `approved` - Aprovado
- `rejected` - Rejeitado (ver rejection_reason)

---

## Tipos de Template (types)

### Texto simples
```json
{
  "types": {
    "twilio/text": {
      "body": "Olá {{1}}, seu pedido está pronto!"
    }
  }
}
```

### Quick Reply (botões de resposta rápida)
```json
{
  "types": {
    "twilio/quick-reply": {
      "body": "Como posso ajudar?",
      "actions": [
        { "id": "btn_1", "title": "Ver pedidos" },
        { "id": "btn_2", "title": "Falar com atendente" }
      ]
    }
  }
}
```

**Limites:**
- Máximo 10 botões
- Título máximo 20 caracteres

### Call to Action (botões URL/telefone)
```json
{
  "types": {
    "twilio/call-to-action": {
      "body": "Acesse nosso site ou ligue para nós",
      "actions": [
        { "type": "URL", "title": "Ver site", "url": "https://exemplo.com" },
        { "type": "PHONE_NUMBER", "title": "Ligar", "phone": "+5511999999999" }
      ]
    }
  }
}
```

**Limites:**
- Máximo 2 botões URL
- Máximo 1 botão telefone
- Título máximo 25 caracteres

### List Picker (lista de opções)
```json
{
  "types": {
    "twilio/list-picker": {
      "body": "Escolha uma opção:",
      "button": "Ver opções",
      "items": [
        { "id": "item_1", "item": "Opção 1", "description": "Descrição da opção 1" },
        { "id": "item_2", "item": "Opção 2", "description": "Descrição da opção 2" }
      ]
    }
  }
}
```

**Limites:**
- Máximo 10 itens
- Título máximo 24 caracteres
- Descrição máximo 72 caracteres

---

## Variáveis em Templates

### Formato
- Use `{{1}}`, `{{2}}`, `{{3}}`, etc.
- Devem ser sequenciais começando em 1
- Não podem ser adjacentes: `{{1}}{{2}}` não é permitido
- Não podem estar no início ou fim da mensagem

### Exemplo
```json
{
  "friendly_name": "confirmacao_pedido",
  "language": "pt_BR",
  "variables": {
    "1": "João Silva",
    "2": "12345"
  },
  "types": {
    "twilio/text": {
      "body": "Olá {{1}}, seu pedido #{{2}} foi confirmado!"
    }
  }
}
```

---

## Webhooks

### Status de Mensagem (SDK)
URL configurada via `statusCallback` no envio.

```http
POST /webhook/twilio/status
Content-Type: application/x-www-form-urlencoded

MessageSid=SMxxxxx&MessageStatus=delivered&ErrorCode=
```

**Status possíveis:**
- `queued` - Na fila
- `sent` - Enviada
- `delivered` - Entregue
- `read` - Lida
- `failed` - Falhou

### Status de Aprovação de Template
URL configurada no Twilio Console.

```http
POST /webhook/twilio/content-status
Content-Type: application/json

{
  "ContentSid": "HXxxxxx",
  "ApprovalStatus": "approved",
  "RejectionReason": null
}
```

---

## Implementação neste Projeto

### Arquivos relevantes
```
src/
├── services/
│   └── twilio-whatsapp-templates.ts  ← Gerencia templates (usa HTTP)
├── webhooks/
│   └── twilio.ts                      ← Webhooks de status
└── routes/
    └── whatsapp-templates.ts          ← API REST de templates
```

### Funções do serviço

| Função | Método | Descrição |
|--------|--------|-----------|
| `createTemplate()` | HTTP POST | Cria template no Twilio |
| `updateTemplate()` | HTTP DELETE + POST | Atualiza (recria) template |
| `deleteTemplate()` | HTTP DELETE | Remove do Twilio |
| `listTemplatesFromTwilio()` | HTTP GET | Lista do Twilio |
| `syncAllTemplates()` | HTTP GET | Sincroniza com banco |
| `submitForApproval()` | HTTP POST | Submete para aprovação |
| `getApprovalStatus()` | HTTP GET | Verifica status |
| `sendTemplateMessage()` | **SDK** | Envia mensagem |

---

## Erros Comuns

### "Invalid types"
O payload deve ter o campo `types` com pelo menos um tipo válido:
```json
{
  "types": {
    "twilio/text": { "body": "..." }
  }
}
```

### "friendly_name is required"
O campo `friendly_name` é obrigatório e deve ser snake_case:
```json
{
  "friendly_name": "meu_template_teste"
}
```

### "Template not approved"
Templates devem ser aprovados pelo WhatsApp antes de enviar.
Use `submitForApproval()` e aguarde o status mudar para `approved`.

---

## Links Úteis

- [Twilio Content API Docs](https://www.twilio.com/docs/content)
- [WhatsApp Message Templates](https://www.twilio.com/docs/whatsapp/message-templates)
- [Twilio Node SDK](https://www.twilio.com/docs/libraries/node)
