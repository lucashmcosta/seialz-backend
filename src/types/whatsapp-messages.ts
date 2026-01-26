// src/types/whatsapp-messages.ts
// Tipos de mensagens interativas do WhatsApp via Twilio

/**
 * Tipos de mensagens suportados pelo WhatsApp Business API
 */
export type WhatsAppMessageType =
  | 'text'
  | 'quick_reply'
  | 'list'
  | 'cta'
  | 'media'
  | 'location'
  | 'location_request'
  | 'card';

/**
 * Botão de resposta rápida (Quick Reply)
 * Máximo 3 botões, título máximo 20 caracteres
 */
export interface QuickReplyButton {
  id: string;
  title: string; // max 20 chars
}

/**
 * Seção de lista para List Message
 * Máximo 10 seções por mensagem
 */
export interface ListSection {
  title?: string; // max 24 chars
  rows: ListRow[];
}

/**
 * Item de lista (row)
 * Máximo 10 itens por seção
 */
export interface ListRow {
  id: string;
  title: string; // max 24 chars
  description?: string; // max 72 chars
}

/**
 * Botão Call to Action (CTA)
 * Máximo 2 botões por mensagem
 */
export interface CTAButton {
  type: 'url' | 'phone';
  title: string; // max 20 chars
  url?: string; // required if type is 'url'
  phone?: string; // required if type is 'phone'
}

/**
 * Conteúdo de mídia
 */
export interface MediaContent {
  type: 'image' | 'video' | 'document' | 'audio';
  url: string;
  caption?: string;
  filename?: string; // required for documents
}

/**
 * Conteúdo de localização
 */
export interface LocationContent {
  latitude: number;
  longitude: number;
  name?: string;
  address?: string;
}

/**
 * Card para mensagens do tipo Card
 */
export interface CardContent {
  title: string; // max 1024 chars
  body?: string;
  media?: {
    type: 'image';
    url: string;
  };
  actions?: CTAButton[];
}

/**
 * Header opcional para mensagens interativas
 */
export interface MessageHeader {
  type: 'text' | 'image' | 'video' | 'document';
  text?: string; // max 60 chars for text type
  url?: string; // URL da mídia
}

/**
 * Mensagem interativa completa do WhatsApp
 */
export interface InteractiveMessage {
  type: WhatsAppMessageType;
  body: string;

  // Quick Reply - Máximo 3 botões
  quickReplyButtons?: QuickReplyButton[];

  // List - Máximo 10 seções, 10 itens por seção
  listButtonText?: string; // max 20 chars, texto do botão que abre a lista
  listSections?: ListSection[];

  // CTA - Máximo 2 botões
  ctaButtons?: CTAButton[];

  // Media
  media?: MediaContent;

  // Location
  location?: LocationContent;

  // Card
  card?: CardContent;

  // Header (opcional para alguns tipos)
  header?: MessageHeader;

  // Footer (opcional)
  footer?: string; // max 60 chars
}

/**
 * Resultado de validação de mensagem
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Limites de caracteres do WhatsApp
 */
export const WHATSAPP_LIMITS = {
  QUICK_REPLY_BUTTON_TITLE: 20,
  QUICK_REPLY_MAX_BUTTONS: 3,
  LIST_SECTION_TITLE: 24,
  LIST_ROW_TITLE: 24,
  LIST_ROW_DESCRIPTION: 72,
  LIST_BUTTON_TEXT: 20,
  LIST_MAX_SECTIONS: 10,
  LIST_MAX_ROWS_PER_SECTION: 10,
  CTA_BUTTON_TITLE: 20,
  CTA_MAX_BUTTONS: 2,
  HEADER_TEXT: 60,
  FOOTER_TEXT: 60,
  BODY_TEXT: 1024,
  CARD_TITLE: 1024,
} as const;

/**
 * Valida uma mensagem interativa
 */
export function validateInteractiveMessage(message: InteractiveMessage): ValidationResult {
  const errors: string[] = [];

  // Validar corpo da mensagem
  if (!message.body || message.body.length === 0) {
    errors.push('Message body is required');
  }
  if (message.body && message.body.length > WHATSAPP_LIMITS.BODY_TEXT) {
    errors.push(`Body exceeds ${WHATSAPP_LIMITS.BODY_TEXT} characters`);
  }

  // Validar footer
  if (message.footer && message.footer.length > WHATSAPP_LIMITS.FOOTER_TEXT) {
    errors.push(`Footer exceeds ${WHATSAPP_LIMITS.FOOTER_TEXT} characters`);
  }

  // Validar header
  if (message.header?.type === 'text' && message.header.text) {
    if (message.header.text.length > WHATSAPP_LIMITS.HEADER_TEXT) {
      errors.push(`Header text exceeds ${WHATSAPP_LIMITS.HEADER_TEXT} characters`);
    }
  }

  // Validações por tipo
  switch (message.type) {
    case 'quick_reply':
      validateQuickReply(message, errors);
      break;
    case 'list':
      validateListMessage(message, errors);
      break;
    case 'cta':
      validateCTAMessage(message, errors);
      break;
    case 'media':
      validateMediaMessage(message, errors);
      break;
    case 'location':
      validateLocationMessage(message, errors);
      break;
    case 'card':
      validateCardMessage(message, errors);
      break;
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateQuickReply(message: InteractiveMessage, errors: string[]): void {
  if (!message.quickReplyButtons || message.quickReplyButtons.length === 0) {
    errors.push('Quick reply requires at least one button');
    return;
  }

  if (message.quickReplyButtons.length > WHATSAPP_LIMITS.QUICK_REPLY_MAX_BUTTONS) {
    errors.push(`Quick reply allows maximum ${WHATSAPP_LIMITS.QUICK_REPLY_MAX_BUTTONS} buttons`);
  }

  message.quickReplyButtons.forEach((button, index) => {
    if (!button.id) {
      errors.push(`Button ${index + 1}: id is required`);
    }
    if (!button.title) {
      errors.push(`Button ${index + 1}: title is required`);
    }
    if (button.title && button.title.length > WHATSAPP_LIMITS.QUICK_REPLY_BUTTON_TITLE) {
      errors.push(`Button ${index + 1}: title exceeds ${WHATSAPP_LIMITS.QUICK_REPLY_BUTTON_TITLE} characters`);
    }
  });
}

function validateListMessage(message: InteractiveMessage, errors: string[]): void {
  if (!message.listButtonText) {
    errors.push('List message requires button text');
  }
  if (message.listButtonText && message.listButtonText.length > WHATSAPP_LIMITS.LIST_BUTTON_TEXT) {
    errors.push(`List button text exceeds ${WHATSAPP_LIMITS.LIST_BUTTON_TEXT} characters`);
  }

  if (!message.listSections || message.listSections.length === 0) {
    errors.push('List message requires at least one section');
    return;
  }

  if (message.listSections.length > WHATSAPP_LIMITS.LIST_MAX_SECTIONS) {
    errors.push(`List allows maximum ${WHATSAPP_LIMITS.LIST_MAX_SECTIONS} sections`);
  }

  message.listSections.forEach((section, sectionIndex) => {
    if (section.title && section.title.length > WHATSAPP_LIMITS.LIST_SECTION_TITLE) {
      errors.push(`Section ${sectionIndex + 1}: title exceeds ${WHATSAPP_LIMITS.LIST_SECTION_TITLE} characters`);
    }

    if (!section.rows || section.rows.length === 0) {
      errors.push(`Section ${sectionIndex + 1}: requires at least one row`);
      return;
    }

    if (section.rows.length > WHATSAPP_LIMITS.LIST_MAX_ROWS_PER_SECTION) {
      errors.push(`Section ${sectionIndex + 1}: exceeds ${WHATSAPP_LIMITS.LIST_MAX_ROWS_PER_SECTION} rows`);
    }

    section.rows.forEach((row, rowIndex) => {
      if (!row.id) {
        errors.push(`Section ${sectionIndex + 1}, Row ${rowIndex + 1}: id is required`);
      }
      if (!row.title) {
        errors.push(`Section ${sectionIndex + 1}, Row ${rowIndex + 1}: title is required`);
      }
      if (row.title && row.title.length > WHATSAPP_LIMITS.LIST_ROW_TITLE) {
        errors.push(`Section ${sectionIndex + 1}, Row ${rowIndex + 1}: title exceeds ${WHATSAPP_LIMITS.LIST_ROW_TITLE} characters`);
      }
      if (row.description && row.description.length > WHATSAPP_LIMITS.LIST_ROW_DESCRIPTION) {
        errors.push(`Section ${sectionIndex + 1}, Row ${rowIndex + 1}: description exceeds ${WHATSAPP_LIMITS.LIST_ROW_DESCRIPTION} characters`);
      }
    });
  });
}

function validateCTAMessage(message: InteractiveMessage, errors: string[]): void {
  if (!message.ctaButtons || message.ctaButtons.length === 0) {
    errors.push('CTA message requires at least one button');
    return;
  }

  if (message.ctaButtons.length > WHATSAPP_LIMITS.CTA_MAX_BUTTONS) {
    errors.push(`CTA allows maximum ${WHATSAPP_LIMITS.CTA_MAX_BUTTONS} buttons`);
  }

  message.ctaButtons.forEach((button, index) => {
    if (!button.title) {
      errors.push(`CTA Button ${index + 1}: title is required`);
    }
    if (button.title && button.title.length > WHATSAPP_LIMITS.CTA_BUTTON_TITLE) {
      errors.push(`CTA Button ${index + 1}: title exceeds ${WHATSAPP_LIMITS.CTA_BUTTON_TITLE} characters`);
    }

    if (button.type === 'url' && !button.url) {
      errors.push(`CTA Button ${index + 1}: url is required for type 'url'`);
    }
    if (button.type === 'phone' && !button.phone) {
      errors.push(`CTA Button ${index + 1}: phone is required for type 'phone'`);
    }
  });
}

function validateMediaMessage(message: InteractiveMessage, errors: string[]): void {
  if (!message.media) {
    errors.push('Media message requires media content');
    return;
  }

  if (!message.media.url) {
    errors.push('Media URL is required');
  }

  if (!['image', 'video', 'document', 'audio'].includes(message.media.type)) {
    errors.push('Invalid media type');
  }

  if (message.media.type === 'document' && !message.media.filename) {
    errors.push('Document requires filename');
  }
}

function validateLocationMessage(message: InteractiveMessage, errors: string[]): void {
  if (!message.location) {
    errors.push('Location message requires location content');
    return;
  }

  if (typeof message.location.latitude !== 'number') {
    errors.push('Latitude is required');
  }
  if (typeof message.location.longitude !== 'number') {
    errors.push('Longitude is required');
  }

  if (message.location.latitude < -90 || message.location.latitude > 90) {
    errors.push('Latitude must be between -90 and 90');
  }
  if (message.location.longitude < -180 || message.location.longitude > 180) {
    errors.push('Longitude must be between -180 and 180');
  }
}

function validateCardMessage(message: InteractiveMessage, errors: string[]): void {
  if (!message.card) {
    errors.push('Card message requires card content');
    return;
  }

  if (!message.card.title) {
    errors.push('Card title is required');
  }
  if (message.card.title && message.card.title.length > WHATSAPP_LIMITS.CARD_TITLE) {
    errors.push(`Card title exceeds ${WHATSAPP_LIMITS.CARD_TITLE} characters`);
  }

  if (message.card.actions && message.card.actions.length > WHATSAPP_LIMITS.CTA_MAX_BUTTONS) {
    errors.push(`Card allows maximum ${WHATSAPP_LIMITS.CTA_MAX_BUTTONS} action buttons`);
  }
}

/**
 * Trunca texto para o limite especificado
 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Prepara botões de quick reply (trunca títulos)
 */
export function prepareQuickReplyButtons(
  buttons: QuickReplyButton[]
): QuickReplyButton[] {
  return buttons.slice(0, WHATSAPP_LIMITS.QUICK_REPLY_MAX_BUTTONS).map((button, index) => ({
    id: button.id || `btn_${index + 1}`,
    title: truncateText(button.title, WHATSAPP_LIMITS.QUICK_REPLY_BUTTON_TITLE),
  }));
}

/**
 * Prepara seções de lista (trunca textos)
 */
export function prepareListSections(
  sections: ListSection[]
): ListSection[] {
  return sections.slice(0, WHATSAPP_LIMITS.LIST_MAX_SECTIONS).map((section, sectionIndex) => ({
    title: section.title
      ? truncateText(section.title, WHATSAPP_LIMITS.LIST_SECTION_TITLE)
      : undefined,
    rows: section.rows.slice(0, WHATSAPP_LIMITS.LIST_MAX_ROWS_PER_SECTION).map((row, rowIndex) => ({
      id: row.id || `section_${sectionIndex}_row_${rowIndex}`,
      title: truncateText(row.title, WHATSAPP_LIMITS.LIST_ROW_TITLE),
      description: row.description
        ? truncateText(row.description, WHATSAPP_LIMITS.LIST_ROW_DESCRIPTION)
        : undefined,
    })),
  }));
}

/**
 * Prepara botões CTA (trunca títulos)
 */
export function prepareCTAButtons(buttons: CTAButton[]): CTAButton[] {
  return buttons.slice(0, WHATSAPP_LIMITS.CTA_MAX_BUTTONS).map((button) => ({
    ...button,
    title: truncateText(button.title, WHATSAPP_LIMITS.CTA_BUTTON_TITLE),
  }));
}
