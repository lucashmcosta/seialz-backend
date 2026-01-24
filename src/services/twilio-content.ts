// src/services/twilio-content.ts
// Serviço para gerenciar Content Templates do Twilio para mensagens interativas do WhatsApp

import type { Twilio } from 'twilio';
import type {
  QuickReplyButton,
  ListSection,
  CTAButton,
  MediaContent,
  LocationContent,
  CardContent,
  InteractiveMessage,
} from '../types/whatsapp-messages.js';
import {
  prepareQuickReplyButtons,
  prepareListSections,
  prepareCTAButtons,
  truncateText,
  WHATSAPP_LIMITS,
} from '../types/whatsapp-messages.js';

/**
 * Cache de Content SIDs para evitar recriação desnecessária
 * Chave: hash do conteúdo, Valor: contentSid
 */
const contentCache = new Map<string, { sid: string; createdAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas

/**
 * Gera um hash simples para usar como chave de cache
 */
function generateCacheKey(prefix: string, data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `${prefix}_${Math.abs(hash).toString(36)}`;
}

/**
 * Verifica se um item do cache ainda é válido
 */
function isCacheValid(entry: { sid: string; createdAt: number } | undefined): boolean {
  if (!entry) return false;
  return Date.now() - entry.createdAt < CACHE_TTL_MS;
}

/**
 * Cria um Content Template para Quick Reply
 * https://www.twilio.com/docs/content/quickreply
 */
export async function createQuickReplyTemplate(
  client: Twilio,
  body: string,
  buttons: QuickReplyButton[]
): Promise<string> {
  const preparedButtons = prepareQuickReplyButtons(buttons);
  const cacheKey = generateCacheKey('qr', { body, buttons: preparedButtons });

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached Quick Reply template: ${cached!.sid}`);
    return cached!.sid;
  }

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `quick_reply_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioQuickReply: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
          actions: preparedButtons.map((btn) => ({
            type: 'QUICK_REPLY' as const,
            title: btn.title,
            id: btn.id,
          })),
        },
        twilioText: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
        },
      },
    });

    console.log(`✅ Created Quick Reply template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating Quick Reply template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template para List Picker
 * https://www.twilio.com/docs/content/list-picker
 */
export async function createListTemplate(
  client: Twilio,
  body: string,
  buttonText: string,
  sections: ListSection[]
): Promise<string> {
  const preparedSections = prepareListSections(sections);
  const cacheKey = generateCacheKey('list', { body, buttonText, sections: preparedSections });

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached List template: ${cached!.sid}`);
    return cached!.sid;
  }

  // Flatten items de todas as seções
  const items = preparedSections.flatMap((section) =>
    section.rows.map((row) => ({
      id: row.id,
      item: row.title,
      description: row.description,
    }))
  );

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `list_picker_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioListPicker: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
          button: truncateText(buttonText, WHATSAPP_LIMITS.LIST_BUTTON_TEXT),
          items,
        },
        twilioText: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
        },
      },
    });

    console.log(`✅ Created List Picker template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating List Picker template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template para Call to Action
 * https://www.twilio.com/docs/content/call-to-action
 */
export async function createCTATemplate(
  client: Twilio,
  body: string,
  buttons: CTAButton[]
): Promise<string> {
  const preparedButtons = prepareCTAButtons(buttons);
  const cacheKey = generateCacheKey('cta', { body, buttons: preparedButtons });

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached CTA template: ${cached!.sid}`);
    return cached!.sid;
  }

  const actions = preparedButtons.map((btn) => {
    if (btn.type === 'url') {
      return {
        type: 'URL' as const,
        title: btn.title,
        url: btn.url,
      };
    } else {
      return {
        type: 'PHONE_NUMBER' as const,
        title: btn.title,
        phone: btn.phone,
      };
    }
  });

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `cta_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioCallToAction: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
          actions,
        },
        twilioText: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
        },
      },
    });

    console.log(`✅ Created CTA template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating CTA template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template para Card
 * https://www.twilio.com/docs/content/card
 */
export async function createCardTemplate(
  client: Twilio,
  card: CardContent,
  body?: string
): Promise<string> {
  const cacheKey = generateCacheKey('card', { card, body });

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached Card template: ${cached!.sid}`);
    return cached!.sid;
  }

  const cardActions = card.actions
    ? prepareCTAButtons(card.actions).map((btn) => {
        if (btn.type === 'url') {
          return {
            type: 'URL' as const,
            title: btn.title,
            url: btn.url,
          };
        } else {
          return {
            type: 'PHONE_NUMBER' as const,
            title: btn.title,
            phone: btn.phone,
          };
        }
      })
    : undefined;

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `card_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioCard: {
          title: truncateText(card.title, WHATSAPP_LIMITS.CARD_TITLE),
          subtitle: card.body,
          media: card.media ? [card.media.url] : undefined,
          actions: cardActions,
        },
        twilioText: {
          body: body || card.title,
        },
      },
    });

    console.log(`✅ Created Card template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating Card template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template para Location
 * https://www.twilio.com/docs/content/location
 */
export async function createLocationTemplate(
  client: Twilio,
  location: LocationContent,
  body?: string
): Promise<string> {
  const cacheKey = generateCacheKey('location', { location, body });

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached Location template: ${cached!.sid}`);
    return cached!.sid;
  }

  const fallbackBody = body || `Location: ${location.name || `${location.latitude}, ${location.longitude}`}`;

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `location_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioLocation: {
          latitude: location.latitude,
          longitude: location.longitude,
          label: location.name,
          address: location.address,
        },
        twilioText: {
          body: fallbackBody,
        },
      },
    });

    console.log(`✅ Created Location template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating Location template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template para Location Request
 * Nota: O WhatsApp não suporta location request via Content API diretamente
 * Usamos uma mensagem de texto com instruções
 */
export async function createLocationRequestTemplate(
  client: Twilio,
  body: string
): Promise<string> {
  const cacheKey = generateCacheKey('loc_req', { body });

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached Location Request template: ${cached!.sid}`);
    return cached!.sid;
  }

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `location_request_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioText: {
          body: truncateText(body, WHATSAPP_LIMITS.BODY_TEXT),
        },
      },
    });

    console.log(`✅ Created Location Request template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating Location Request template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template para Media
 * https://www.twilio.com/docs/content/media
 */
export async function createMediaTemplate(
  client: Twilio,
  media: MediaContent
): Promise<string> {
  const cacheKey = generateCacheKey('media', media);

  const cached = contentCache.get(cacheKey);
  if (isCacheValid(cached)) {
    console.log(`📋 Using cached Media template: ${cached!.sid}`);
    return cached!.sid;
  }

  try {
    const content = await client.content.v1.contents.create({
      friendlyName: `media_${media.type}_${Date.now()}`,
      language: 'pt_BR',
      types: {
        twilioMedia: {
          body: media.caption,
          media: [media.url],
        },
        twilioText: {
          body: media.caption || `[${media.type}]`,
        },
      },
    });

    console.log(`✅ Created Media template: ${content.sid}`);
    contentCache.set(cacheKey, { sid: content.sid, createdAt: Date.now() });
    return content.sid;
  } catch (error) {
    console.error('❌ Error creating Media template:', error);
    throw error;
  }
}

/**
 * Cria um Content Template baseado no tipo de mensagem interativa
 */
export async function createContentTemplate(
  client: Twilio,
  message: InteractiveMessage
): Promise<string | null> {
  switch (message.type) {
    case 'quick_reply':
      if (!message.quickReplyButtons) return null;
      return createQuickReplyTemplate(client, message.body, message.quickReplyButtons);

    case 'list':
      if (!message.listSections || !message.listButtonText) return null;
      return createListTemplate(
        client,
        message.body,
        message.listButtonText,
        message.listSections
      );

    case 'cta':
      if (!message.ctaButtons) return null;
      return createCTATemplate(client, message.body, message.ctaButtons);

    case 'card':
      if (!message.card) return null;
      return createCardTemplate(client, message.card, message.body);

    case 'location':
      if (!message.location) return null;
      return createLocationTemplate(client, message.location, message.body);

    case 'location_request':
      return createLocationRequestTemplate(client, message.body);

    case 'media':
      if (!message.media) return null;
      return createMediaTemplate(client, message.media);

    default:
      return null;
  }
}

/**
 * Limpa o cache de Content Templates
 */
export function clearContentCache(): void {
  contentCache.clear();
  console.log('🧹 Content template cache cleared');
}

/**
 * Remove entradas expiradas do cache
 */
export function pruneContentCache(): number {
  const now = Date.now();
  let pruned = 0;

  for (const [key, entry] of contentCache.entries()) {
    if (now - entry.createdAt >= CACHE_TTL_MS) {
      contentCache.delete(key);
      pruned++;
    }
  }

  if (pruned > 0) {
    console.log(`🧹 Pruned ${pruned} expired content template(s) from cache`);
  }

  return pruned;
}

/**
 * Deleta um Content Template do Twilio
 */
export async function deleteContentTemplate(
  client: Twilio,
  contentSid: string
): Promise<boolean> {
  try {
    await client.content.v1.contents(contentSid).remove();
    console.log(`🗑️ Deleted content template: ${contentSid}`);

    // Remover do cache se existir
    for (const [key, entry] of contentCache.entries()) {
      if (entry.sid === contentSid) {
        contentCache.delete(key);
        break;
      }
    }

    return true;
  } catch (error) {
    console.error(`❌ Error deleting content template ${contentSid}:`, error);
    return false;
  }
}

/**
 * Lista todos os Content Templates da conta
 */
export async function listContentTemplates(
  client: Twilio,
  limit?: number
): Promise<Array<{ sid: string; friendlyName: string }>> {
  try {
    const contents = await client.content.v1.contents.list({ limit: limit || 100 });
    return contents.map((c) => ({
      sid: c.sid,
      friendlyName: c.friendlyName || '',
    }));
  } catch (error) {
    console.error('❌ Error listing content templates:', error);
    return [];
  }
}
