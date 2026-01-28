// src/lib/template-validation.ts
// Validações para WhatsApp Business Message Templates

export interface TemplateVariable {
  key: string;
  name: string;
  example: string;
}

export interface TemplateButton {
  id: string;
  title: string;
}

export interface TemplateAction {
  type: 'quick_reply' | 'url' | 'phone' | 'copy_code' | 'list_item';
  title: string;
  url?: string;
  phone?: string;
  code?: string;
  description?: string;
  section?: string;
}

export interface TemplateValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Limites do WhatsApp Business API para templates
 */
export const TEMPLATE_LIMITS = {
  NAME_MAX_LENGTH: 512,
  BODY_MAX_LENGTH: 1024,
  HEADER_MAX_LENGTH: 60,
  FOOTER_MAX_LENGTH: 60,
  QUICK_REPLY_MAX_BUTTONS: 10,
  QUICK_REPLY_TITLE_MAX: 20,
  CTA_MAX_URL_BUTTONS: 2,
  CTA_MAX_PHONE_BUTTONS: 1,
  CTA_TITLE_MAX: 25,
  LIST_MAX_ITEMS: 10,
  LIST_ITEM_TITLE_MAX: 24,
  LIST_ITEM_DESC_MAX: 72,
} as const;

/**
 * Regex para validar nome do template (snake_case, lowercase)
 */
const TEMPLATE_NAME_REGEX = /^[a-z][a-z0-9_]*$/;

/**
 * Regex para encontrar variáveis no template {{1}}, {{2}}, etc.
 */
const VARIABLE_REGEX = /\{\{(\d+)\}\}/g;

/**
 * Valida o nome do template
 * - Deve ser snake_case
 * - Apenas lowercase e números
 * - Máximo 512 caracteres
 */
export function validateTemplateName(name: string): TemplateValidationResult {
  const errors: string[] = [];

  if (!name) {
    errors.push('Template name is required');
    return { valid: false, errors };
  }

  if (name.length > TEMPLATE_LIMITS.NAME_MAX_LENGTH) {
    errors.push(`Template name exceeds ${TEMPLATE_LIMITS.NAME_MAX_LENGTH} characters`);
  }

  if (!TEMPLATE_NAME_REGEX.test(name)) {
    errors.push('Template name must be snake_case (lowercase letters, numbers, underscores only, starting with a letter)');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Valida o body do template e suas variáveis
 * - Máximo 1024 caracteres
 * - Variáveis devem ser sequenciais: {{1}}, {{2}}, {{3}}
 * - Variáveis não podem ser adjacentes: {{1}}{{2}} não é permitido
 * - Variáveis não podem estar no início ou fim do texto
 */
export function validateTemplateBody(body: string): TemplateValidationResult {
  const errors: string[] = [];

  if (!body) {
    errors.push('Template body is required');
    return { valid: false, errors };
  }

  if (body.length > TEMPLATE_LIMITS.BODY_MAX_LENGTH) {
    errors.push(`Template body exceeds ${TEMPLATE_LIMITS.BODY_MAX_LENGTH} characters`);
  }

  // Extrair variáveis
  const matches = [...body.matchAll(VARIABLE_REGEX)];
  const variableNumbers = matches.map(m => parseInt(m[1])).sort((a, b) => a - b);

  if (variableNumbers.length > 0) {
    // Verificar se começam com 1 e são sequenciais
    for (let i = 0; i < variableNumbers.length; i++) {
      const expected = i + 1;
      if (variableNumbers[i] !== expected) {
        errors.push(`Variables must be sequential starting from {{1}}. Expected {{${expected}}}, found {{${variableNumbers[i]}}}`);
        break;
      }
    }

    // Verificar variáveis adjacentes
    if (/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body)) {
      errors.push('Variables cannot be adjacent to each other (e.g., {{1}}{{2}} is not allowed)');
    }

    // Verificar variável no início
    if (/^\s*\{\{\d+\}\}/.test(body)) {
      errors.push('Variables cannot be at the beginning of the message');
    }

    // Verificar variável no fim
    if (/\{\{\d+\}\}\s*$/.test(body)) {
      errors.push('Variables cannot be at the end of the message');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Valida o header do template
 * - Máximo 60 caracteres
 */
export function validateTemplateHeader(header: string | undefined): TemplateValidationResult {
  const errors: string[] = [];

  if (header && header.length > TEMPLATE_LIMITS.HEADER_MAX_LENGTH) {
    errors.push(`Header exceeds ${TEMPLATE_LIMITS.HEADER_MAX_LENGTH} characters`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Valida o footer do template
 * - Máximo 60 caracteres
 */
export function validateTemplateFooter(footer: string | undefined): TemplateValidationResult {
  const errors: string[] = [];

  if (footer && footer.length > TEMPLATE_LIMITS.FOOTER_MAX_LENGTH) {
    errors.push(`Footer exceeds ${TEMPLATE_LIMITS.FOOTER_MAX_LENGTH} characters`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Valida botões de quick-reply
 * - Máximo 10 botões
 * - Título máximo 20 caracteres
 */
export function validateQuickReplyButtons(buttons: TemplateButton[] | undefined): TemplateValidationResult {
  const errors: string[] = [];

  if (!buttons || buttons.length === 0) {
    return { valid: true, errors };
  }

  if (buttons.length > TEMPLATE_LIMITS.QUICK_REPLY_MAX_BUTTONS) {
    errors.push(`Quick-reply allows maximum ${TEMPLATE_LIMITS.QUICK_REPLY_MAX_BUTTONS} buttons`);
  }

  buttons.forEach((button, index) => {
    if (!button.id) {
      errors.push(`Button ${index + 1}: id is required`);
    }
    if (!button.title) {
      errors.push(`Button ${index + 1}: title is required`);
    }
    if (button.title && button.title.length > TEMPLATE_LIMITS.QUICK_REPLY_TITLE_MAX) {
      errors.push(`Button ${index + 1}: title exceeds ${TEMPLATE_LIMITS.QUICK_REPLY_TITLE_MAX} characters`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Valida ações de CTA (Call to Action)
 * - Máximo 2 botões URL
 * - Máximo 1 botão de telefone
 * - Título máximo 25 caracteres
 */
export function validateCTAActions(actions: TemplateAction[] | undefined): TemplateValidationResult {
  const errors: string[] = [];

  if (!actions || actions.length === 0) {
    return { valid: true, errors };
  }

  const urlButtons = actions.filter(a => a.type === 'url');
  const phoneButtons = actions.filter(a => a.type === 'phone');

  if (urlButtons.length > TEMPLATE_LIMITS.CTA_MAX_URL_BUTTONS) {
    errors.push(`CTA allows maximum ${TEMPLATE_LIMITS.CTA_MAX_URL_BUTTONS} URL buttons`);
  }

  if (phoneButtons.length > TEMPLATE_LIMITS.CTA_MAX_PHONE_BUTTONS) {
    errors.push(`CTA allows maximum ${TEMPLATE_LIMITS.CTA_MAX_PHONE_BUTTONS} phone button`);
  }

  actions.forEach((action, index) => {
    if (!action.title) {
      errors.push(`Action ${index + 1}: title is required`);
    }
    if (action.title && action.title.length > TEMPLATE_LIMITS.CTA_TITLE_MAX) {
      errors.push(`Action ${index + 1}: title exceeds ${TEMPLATE_LIMITS.CTA_TITLE_MAX} characters`);
    }

    if (action.type === 'url' && !action.url) {
      errors.push(`Action ${index + 1}: url is required for type 'url'`);
    }
    if (action.type === 'phone' && !action.phone) {
      errors.push(`Action ${index + 1}: phone is required for type 'phone'`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Valida itens de list-picker
 * - Máximo 10 itens
 * - Título máximo 24 caracteres
 * - Descrição máximo 72 caracteres
 */
export function validateListItems(actions: TemplateAction[] | undefined): TemplateValidationResult {
  const errors: string[] = [];

  if (!actions || actions.length === 0) {
    return { valid: true, errors };
  }

  const listItems = actions.filter(a => a.type === 'list_item');

  if (listItems.length > TEMPLATE_LIMITS.LIST_MAX_ITEMS) {
    errors.push(`List allows maximum ${TEMPLATE_LIMITS.LIST_MAX_ITEMS} items`);
  }

  listItems.forEach((item, index) => {
    if (!item.title) {
      errors.push(`List item ${index + 1}: title is required`);
    }
    if (item.title && item.title.length > TEMPLATE_LIMITS.LIST_ITEM_TITLE_MAX) {
      errors.push(`List item ${index + 1}: title exceeds ${TEMPLATE_LIMITS.LIST_ITEM_TITLE_MAX} characters`);
    }
    if (item.description && item.description.length > TEMPLATE_LIMITS.LIST_ITEM_DESC_MAX) {
      errors.push(`List item ${index + 1}: description exceeds ${TEMPLATE_LIMITS.LIST_ITEM_DESC_MAX} characters`);
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Extrai variáveis do body do template
 */
export function extractVariables(body: string): number[] {
  const matches = [...body.matchAll(VARIABLE_REGEX)];
  return matches.map(m => parseInt(m[1])).sort((a, b) => a - b);
}

/**
 * Valida que as variáveis fornecidas correspondem às do body
 */
export function validateVariables(
  body: string,
  variables: TemplateVariable[] | undefined
): TemplateValidationResult {
  const errors: string[] = [];
  const bodyVariables = extractVariables(body);

  if (bodyVariables.length === 0 && (!variables || variables.length === 0)) {
    return { valid: true, errors };
  }

  if (bodyVariables.length > 0 && (!variables || variables.length === 0)) {
    errors.push(`Body contains ${bodyVariables.length} variable(s) but no variables were defined`);
    return { valid: false, errors };
  }

  if (variables) {
    const variableKeys = variables.map(v => parseInt(v.key)).sort((a, b) => a - b);

    // Verificar se cada variável do body tem correspondência
    for (const bodyVar of bodyVariables) {
      if (!variableKeys.includes(bodyVar)) {
        errors.push(`Variable {{${bodyVar}}} in body has no corresponding definition`);
      }
    }

    // Verificar se cada variável definida existe no body
    for (const varKey of variableKeys) {
      if (!bodyVariables.includes(varKey)) {
        errors.push(`Variable with key "${varKey}" is defined but not used in body`);
      }
    }

    // Verificar se cada variável tem exemplo
    variables.forEach((v, index) => {
      if (!v.example || v.example.trim() === '') {
        errors.push(`Variable ${index + 1} (key: ${v.key}): example is required`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Tipos de template válidos
 */
export const VALID_TEMPLATE_TYPES = ['text', 'quick-reply', 'list-picker', 'call-to-action', 'media'] as const;
export type TemplateType = typeof VALID_TEMPLATE_TYPES[number];

/**
 * Categorias válidas do WhatsApp
 */
export const VALID_CATEGORIES = ['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const;
export type TemplateCategory = typeof VALID_CATEGORIES[number];

/**
 * Valida um template completo
 */
export function validateTemplate(data: {
  friendly_name: string;
  template_type: string;
  body: string;
  header?: string;
  footer?: string;
  variables?: TemplateVariable[];
  buttons?: TemplateButton[];
  actions?: TemplateAction[];
  category?: string;
}): TemplateValidationResult {
  const allErrors: string[] = [];

  // Validar nome
  const nameResult = validateTemplateName(data.friendly_name);
  allErrors.push(...nameResult.errors);

  // Validar tipo
  if (!VALID_TEMPLATE_TYPES.includes(data.template_type as TemplateType)) {
    allErrors.push(`Invalid template_type. Must be one of: ${VALID_TEMPLATE_TYPES.join(', ')}`);
  }

  // Validar categoria (se fornecida)
  if (data.category && !VALID_CATEGORIES.includes(data.category as TemplateCategory)) {
    allErrors.push(`Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}`);
  }

  // Validar body
  const bodyResult = validateTemplateBody(data.body);
  allErrors.push(...bodyResult.errors);

  // Validar header
  const headerResult = validateTemplateHeader(data.header);
  allErrors.push(...headerResult.errors);

  // Validar footer
  const footerResult = validateTemplateFooter(data.footer);
  allErrors.push(...footerResult.errors);

  // Validar variáveis
  const variablesResult = validateVariables(data.body, data.variables);
  allErrors.push(...variablesResult.errors);

  // Validações específicas por tipo
  switch (data.template_type) {
    case 'quick-reply':
      if (!data.buttons || data.buttons.length === 0) {
        allErrors.push('Quick-reply template requires at least one button');
      } else {
        const buttonsResult = validateQuickReplyButtons(data.buttons);
        allErrors.push(...buttonsResult.errors);
      }
      break;

    case 'call-to-action':
      if (!data.actions || data.actions.length === 0) {
        allErrors.push('Call-to-action template requires at least one action');
      } else {
        const ctaResult = validateCTAActions(data.actions);
        allErrors.push(...ctaResult.errors);
      }
      break;

    case 'list-picker':
      if (!data.actions || data.actions.length === 0) {
        allErrors.push('List-picker template requires at least one list item');
      } else {
        const listResult = validateListItems(data.actions);
        allErrors.push(...listResult.errors);
      }
      break;
  }

  return { valid: allErrors.length === 0, errors: allErrors };
}
