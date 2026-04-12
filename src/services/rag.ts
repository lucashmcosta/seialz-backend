import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';

// =============================================================================
// TIPOS
// =============================================================================

interface KnowledgeChunk {
  id?: string;
  content: string;
  title?: string;
  scope?: 'product' | 'global';
  category?: string;
  similarity?: number;
  product_id?: string;
  product_name?: string;
}

interface RerankResult {
  index: number;
  relevance_score: number;
}

interface RAGContext {
  content: string;
  title?: string;
  scope: 'product' | 'global';
  category: string;
}

interface Product {
  id: string;
  name: string;
  slug?: string;
}

interface RAGDebugInfo {
  query: string;
  detectedProducts: string[];
  candidatesFound: number;
  candidatesBySource: Record<string, number>;
  topChunksAfterRerank: Array<{ title?: string; similarity?: number }>;
}

// =============================================================================
// CONFIGURAÇÕES
// =============================================================================

const VOYAGE_API_URL = 'https://api.voyageai.com/v1';
const EMBEDDING_MODEL = 'voyage-3';
const RERANK_MODEL = 'rerank-2';
const CANDIDATE_COUNT = 30;
const LOW_THRESHOLD = 0.30;
const EMERGENCY_THRESHOLD = 0.20;
const TOP_K_AFTER_RERANK = 5;
const MESSAGE_HISTORY_COUNT = 15;  // Aumentado de 3 para 15

// =============================================================================
// ALIASES DE PRODUTOS
// Mapeamento de termos comuns para slugs de produtos
// =============================================================================

const PRODUCT_ALIASES: Record<string, string[]> = {
  'visto-de-turista-eua': [
    'visto de turismo',
    'visto turismo',
    'visto de turista',
    'visto turista',
    'visto americano',
    'visto eua',
    'visto usa',
    'visto b1',
    'visto b2',
    'visto b1/b2',
    'só o visto',
    'somente o visto',
    'apenas o visto',
    'só visto',
    'somente visto',
  ],
  'passaporte': [
    'passaporte brasileiro',
    'passaporte br',
    'só passaporte',
    'somente passaporte',
    'apenas passaporte',
    'só o passaporte',
    'somente o passaporte',
  ],
  'visto-de-turista-e-passaporte': [
    'combo',
    'passaporte e visto',
    'visto e passaporte',
    'passaporte + visto',
    'visto + passaporte',
    'os dois',
    'ambos',
    'pacote completo',
  ],
};

// =============================================================================
// DETECÇÃO DE MENSAGENS SIMPLES (ACKNOWLEDGMENTS)
// =============================================================================

/**
 * Mensagens que são acknowledgments simples e não requerem RAG
 * Estas mensagens indicam que o usuário está apenas confirmando/agradecendo
 */
const SIMPLE_ACKNOWLEDGMENTS = [
  // Agradecimentos
  'obrigado', 'obrigada', 'obg', 'vlw', 'valeu', 'thanks', 'thank you',
  'muito obrigado', 'muito obrigada', 'brigado', 'brigada',
  // Confirmações simples
  'ok', 'okay', 'tá', 'ta', 'tá bom', 'ta bom', 'beleza', 'blz', 'show',
  'perfeito', 'perfeita', 'ótimo', 'otimo', 'ótima', 'otima', 'maravilha',
  'certo', 'entendi', 'entendido', 'compreendi', 'compreendido',
  'legal', 'massa', 'top', 'nice', 'boa', 'bom',
  // Despedidas
  'tchau', 'até', 'ate', 'até mais', 'ate mais', 'até logo', 'ate logo',
  'bye', 'adeus', 'falou', 'flw', 'fui',
  // Saudações que não precisam de RAG
  'bom dia', 'boa tarde', 'boa noite', 'oi', 'olá', 'ola', 'hello', 'hi',
];

/**
 * Padrões regex para detectar acknowledgments mais complexos
 */
const ACKNOWLEDGMENT_PATTERNS = [
  /^(muito\s+)?obrigad[oa]/i,
  /^(ok|okay|tá|ta|beleza|blz|show|perfeito|ótimo|legal)/i,
  /^(entendi|entendido|compreendi)/i,
  /^(tchau|até|bye|adeus|falou|flw)/i,
  /^(bom dia|boa tarde|boa noite|oi|olá)/i,
  /^[\s\p{Emoji}]*$/u,  // Apenas emojis ou espaços
];

/**
 * Verifica se uma mensagem é um acknowledgment simples
 * Essas mensagens não precisam de RAG porque são apenas confirmações
 */
export function isSimpleAcknowledgment(message: string): boolean {
  const normalized = message.toLowerCase().trim();

  // Mensagens muito curtas (menos de 3 chars úteis) geralmente são acknowledgments
  if (normalized.replace(/[^\w]/g, '').length < 3) {
    return true;
  }

  // Verifica lista de acknowledgments conhecidos
  if (SIMPLE_ACKNOWLEDGMENTS.includes(normalized)) {
    return true;
  }

  // Verifica padrões regex
  for (const pattern of ACKNOWLEDGMENT_PATTERNS) {
    if (pattern.test(normalized)) {
      return true;
    }
  }

  return false;
}

/**
 * Verifica se deve pular RAG para esta mensagem
 * Retorna true se a mensagem não precisa de contexto da knowledge base
 */
export function shouldSkipRAG(
  message: string,
  messageHistory: Array<{ content?: string; direction: string }> = []
): { skip: boolean; reason?: string } {
  // 1. Verifica se é acknowledgment simples
  if (isSimpleAcknowledgment(message)) {
    return {
      skip: true,
      reason: 'Simple acknowledgment detected (obrigado, ok, etc.)'
    };
  }

  // 2. Se a mensagem tem menos de 5 palavras E não menciona nada específico
  const words = message.trim().split(/\s+/);
  if (words.length < 5) {
    // Verifica se tem keywords que indicam necessidade de RAG
    const needsRAGKeywords = [
      'preço', 'preco', 'valor', 'custo', 'quanto',
      'link', 'pagar', 'pagamento', 'pix',
      'prazo', 'tempo', 'demora', 'quanto tempo',
      'como', 'onde', 'quando', 'qual',
      'documento', 'documentos', 'requisito',
      'visto', 'passaporte', 'combo',
    ];

    const messageLower = message.toLowerCase();
    const hasRAGKeyword = needsRAGKeywords.some(k => messageLower.includes(k));

    if (!hasRAGKeyword) {
      return {
        skip: true,
        reason: 'Short message without specific keywords'
      };
    }
  }

  return { skip: false };
}

// =============================================================================
// FUNÇÕES DE EMBEDDING E RERANK
// =============================================================================

/**
 * Gera embedding via Voyage AI
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const voyageApiKey = env.VOYAGE_API_KEY;

  if (!voyageApiKey) {
    console.error('❌ VOYAGE_API_KEY not configured');
    return null;
  }

  try {
    const response = await fetch(`${VOYAGE_API_URL}/embeddings`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${voyageApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: text,
        input_type: 'query',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Voyage embedding error:', error);
      return null;
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding || embedding.length !== 1024) {
      console.error(`❌ Invalid embedding: got ${embedding?.length || 0} dims, expected 1024`);
      return null;
    }

    return embedding;
  } catch (error) {
    console.error('❌ Error generating embedding:', error);
    return null;
  }
}

/**
 * Rerank resultados via Voyage AI
 */
export async function rerankResults(
  query: string,
  documents: string[],
  topK: number = TOP_K_AFTER_RERANK
): Promise<number[]> {
  const voyageApiKey = env.VOYAGE_API_KEY;

  if (documents.length <= topK) {
    return documents.map((_, i) => i);
  }

  if (!voyageApiKey) {
    console.warn('⚠️ VOYAGE_API_KEY not configured, skipping rerank');
    return documents.slice(0, topK).map((_, i) => i);
  }

  try {
    const response = await fetch(`${VOYAGE_API_URL}/rerank`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${voyageApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query: query,
        documents: documents,
        top_k: topK,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Voyage rerank error:', error);
      return documents.slice(0, topK).map((_, i) => i);
    }

    const data = await response.json();
    const results: RerankResult[] = data.data || [];

    return results.map(r => r.index);
  } catch (error) {
    console.error('❌ Error reranking:', error);
    return documents.slice(0, topK).map((_, i) => i);
  }
}

// =============================================================================
// DETECÇÃO DE PRODUTOS (MÚLTIPLOS)
// =============================================================================

/**
 * Detecta TODOS os produtos mencionados no texto (não apenas o primeiro)
 * Usa aliases para melhor detecção
 */
export function detectAllProductsInMessage(
  messageText: string,
  products: Product[]
): string[] {
  const messageLower = messageText.toLowerCase();
  const detectedIds = new Set<string>();

  // 1. Primeiro, verificar aliases (mais específicos)
  for (const [slug, aliases] of Object.entries(PRODUCT_ALIASES)) {
    for (const alias of aliases) {
      if (messageLower.includes(alias.toLowerCase())) {
        // Encontrar o produto pelo slug
        const product = products.find(p => p.slug === slug);
        if (product) {
          detectedIds.add(product.id);
        }
      }
    }
  }

  // 2. Depois, verificar nome/slug direto dos produtos
  for (const product of products) {
    // Verifica nome do produto
    if (product.name && messageLower.includes(product.name.toLowerCase())) {
      detectedIds.add(product.id);
    }

    // Verifica slug
    if (product.slug && messageLower.includes(product.slug.toLowerCase())) {
      detectedIds.add(product.id);
    }

    // Variações do slug (sem hífen, com espaço)
    if (product.slug) {
      const variations = [
        product.slug.replace(/-/g, ' '),
        product.slug.replace(/-/g, ''),
      ];
      for (const variation of variations) {
        if (messageLower.includes(variation.toLowerCase())) {
          detectedIds.add(product.id);
        }
      }
    }
  }

  return Array.from(detectedIds);
}

/**
 * Detecta produto único (backward compatibility)
 */
export function detectProductInMessage(
  messageText: string,
  products: Product[]
): string | null {
  const detected = detectAllProductsInMessage(messageText, products);
  return detected.length > 0 ? detected[0] : null;
}

// =============================================================================
// BUSCA DE CONHECIMENTO (HÍBRIDA)
// =============================================================================

/**
 * Busca conhecimento de forma híbrida:
 * 1. Busca em TODOS os produtos detectados
 * 2. SEMPRE busca em global
 * 3. Se nenhum produto detectado, busca em TUDO
 * 4. Merge e deduplica resultados
 */
export async function searchKnowledgeHybrid(
  embedding: number[],
  organizationId: string,
  productIds: string[]
): Promise<{ candidates: KnowledgeChunk[]; sourceStats: Record<string, number> }> {
  const allCandidates: KnowledgeChunk[] = [];
  const sourceStats: Record<string, number> = {};

  try {
    // CASO 1: Produtos detectados - buscar em cada um + global
    if (productIds.length > 0) {
      // Buscar em cada produto detectado
      for (const productId of productIds) {
        const { data: productResults, error: productError } = await supabase.rpc('search_knowledge_product', {
          query_embedding: embedding,
          org_id: organizationId,
          p_product_id: productId,
          p_categories: null,
          match_threshold: LOW_THRESHOLD,
          match_count: CANDIDATE_COUNT,
        });

        if (productError) {
          console.error(`❌ search_knowledge_product error for ${productId}:`, productError);
        } else if (productResults) {
          const resultsWithSource = productResults.map((r: KnowledgeChunk) => ({
            ...r,
            product_id: productId,
          }));
          allCandidates.push(...resultsWithSource);
          sourceStats[`product_${productId}`] = productResults.length;
        }
      }

      // SEMPRE buscar global também
      const { data: globalResults, error: globalError } = await supabase.rpc('search_knowledge_global', {
        query_embedding: embedding,
        org_id: organizationId,
        p_categories: null,
        match_threshold: LOW_THRESHOLD,
        match_count: CANDIDATE_COUNT,
      });

      if (globalError) {
        console.error('❌ search_knowledge_global error:', globalError);
      } else if (globalResults) {
        allCandidates.push(...globalResults);
        sourceStats['global'] = globalResults.length;
      }
    }
    // CASO 2: Nenhum produto detectado - buscar em TUDO
    else {
      const { data: allResults, error: allError } = await supabase.rpc('search_knowledge_all', {
        query_embedding: embedding,
        org_id: organizationId,
        match_threshold: LOW_THRESHOLD,
        match_count: CANDIDATE_COUNT,
      });

      if (allError) {
        console.error('❌ search_knowledge_all error:', allError);
      } else if (allResults) {
        allCandidates.push(...allResults);
        sourceStats['all'] = allResults.length;
      }
    }

    // Fallback de emergência se não encontrou nada
    if (allCandidates.length === 0) {
      console.log('⚠️ No candidates found, trying emergency fallback (threshold: 0.20)...');
      const { data: fallbackResults, error: fallbackError } = await supabase.rpc('search_knowledge_all', {
        query_embedding: embedding,
        org_id: organizationId,
        match_threshold: EMERGENCY_THRESHOLD,
        match_count: CANDIDATE_COUNT,
      });

      if (!fallbackError && fallbackResults) {
        allCandidates.push(...fallbackResults);
        sourceStats['emergency_fallback'] = fallbackResults.length;
      }
    }

    // Deduplica por content (remove duplicados exatos)
    const seen = new Set<string>();
    const uniqueCandidates = allCandidates.filter(c => {
      const key = c.content.substring(0, 100); // Usa primeiros 100 chars como key
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { candidates: uniqueCandidates, sourceStats };

  } catch (error) {
    console.error('❌ Error in searchKnowledgeHybrid:', error);
    return { candidates: [], sourceStats: {} };
  }
}

// =============================================================================
// FUNÇÕES AUXILIARES
// =============================================================================

/**
 * Busca produtos ativos da organização
 */
export async function getOrganizationProducts(organizationId: string): Promise<Product[]> {
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, slug')
      .eq('organization_id', organizationId)
      .eq('is_active', true);

    if (error) {
      console.error('❌ Error fetching products:', error);
      return [];
    }

    return data || [];
  } catch (error) {
    console.error('❌ Error fetching products:', error);
    return [];
  }
}

/**
 * Extrai contexto das últimas mensagens do usuário (aumentado para 15)
 */
export function extractSearchContext(
  currentMessage: string,
  messageHistory: Array<{ content?: string; direction: string }>
): string {
  // Apenas mensagens INBOUND (do usuário) - últimas 15
  const recentUserMessages = messageHistory
    .filter(m => m.direction === 'inbound')
    .slice(-MESSAGE_HISTORY_COUNT)
    .map(m => m.content || '')
    .filter(c => c.trim() !== '')
    .join(' ');

  // Prioriza mensagem atual; adiciona contexto se msg atual for curta
  if (currentMessage.length < 50 && recentUserMessages) {
    return `${recentUserMessages} ${currentMessage}`;
  }

  return currentMessage;
}

// =============================================================================
// FUNÇÃO PRINCIPAL: getRelevantContext
// =============================================================================

/**
 * Função principal: busca contexto relevante para RAG
 * Usa busca híbrida com múltiplos produtos
 *
 * IMPORTANTE: Verifica se deve pular RAG para mensagens simples (acknowledgments)
 */
export async function getRelevantContext(
  message: string,
  organizationId: string,
  messageHistory: Array<{ content?: string; direction: string }> = []
): Promise<RAGContext[]> {
  console.log('🔍 Starting RAG retrieval...');

  // NOVO: Verificar se deve pular RAG (acknowledgments, mensagens simples)
  const skipCheck = shouldSkipRAG(message, messageHistory);
  if (skipCheck.skip) {
    console.log(`⏭️ Skipping RAG: ${skipCheck.reason}`);
    return [];
  }

  const debugInfo: Partial<RAGDebugInfo> = {};

  // 1. Buscar produtos da organização
  const products = await getOrganizationProducts(organizationId);
  console.log(`   Found ${products.length} products`);

  // 2. Extrair contexto de busca (usa últimas 15 mensagens)
  const searchContext = extractSearchContext(message, messageHistory);
  debugInfo.query = searchContext.substring(0, 200);
  console.log(`   Search context: "${searchContext.substring(0, 100)}..."`);

  // 3. Detectar produtos - PRIORIZA CLARIFICAÇÕES RECENTES
  // Se a mensagem atual tem palavras de clarificação (só, somente, apenas),
  // usar APENAS a mensagem atual para detecção
  const clarificationKeywords = ['só', 'somente', 'apenas', 'só o', 'somente o', 'apenas o'];
  const messageLower = message.toLowerCase();
  const isClarification = clarificationKeywords.some(k => messageLower.includes(k));

  let detectedProductIds: string[] = [];

  if (isClarification) {
    // PRIORIDADE: Usar apenas a mensagem atual (é uma clarificação)
    detectedProductIds = detectAllProductsInMessage(message, products);
    console.log(`   🎯 Clarification detected - using only current message for product detection`);
  } else {
    // Comportamento normal: detecta na mensagem atual
    detectedProductIds = detectAllProductsInMessage(message, products);
  }

  // Se não encontrou na mensagem atual E não é clarificação, verifica histórico
  if (detectedProductIds.length === 0 && !isClarification && messageHistory.length > 0) {
    // NOVO: Verifica apenas as últimas 5 mensagens (não 10) para evitar pegar contexto muito antigo
    const recentMessages = messageHistory.slice(-5).reverse();
    for (const msg of recentMessages) {
      if (msg.content) {
        const detected = detectAllProductsInMessage(msg.content, products);
        if (detected.length > 0) {
          detectedProductIds = detected;
          break;
        }
      }
    }
  }

  // Log produtos detectados
  if (detectedProductIds.length > 0) {
    const productNames = detectedProductIds.map(id => {
      const p = products.find(prod => prod.id === id);
      return p?.name || id;
    });
    console.log(`   Detected products: ${productNames.join(', ')}`);
    debugInfo.detectedProducts = productNames;
  } else {
    console.log('   No specific product detected, searching all');
    debugInfo.detectedProducts = [];
  }

  // 4. Gerar embedding
  const embedding = await generateEmbedding(searchContext);
  if (!embedding) {
    console.error('❌ Failed to generate embedding');
    return [];
  }
  console.log('   Embedding generated (1024 dims)');

  // 5. Busca híbrida (múltiplos produtos + global)
  const { candidates, sourceStats } = await searchKnowledgeHybrid(
    embedding,
    organizationId,
    detectedProductIds
  );

  debugInfo.candidatesFound = candidates.length;
  debugInfo.candidatesBySource = sourceStats;

  console.log(`📚 Found ${candidates.length} knowledge candidates`);
  console.log(`   Sources: ${JSON.stringify(sourceStats)}`);

  if (candidates.length === 0) {
    console.log('⚠️ No knowledge candidates found');
    return [];
  }

  // 6. Rerankar todos os resultados juntos
  const documents = candidates.map(c => c.content);
  const rerankedIndices = await rerankResults(searchContext, documents, TOP_K_AFTER_RERANK);
  console.log(`   Reranked to top ${rerankedIndices.length} results`);

  // 7. Construir resultado final
  const results: RAGContext[] = rerankedIndices
    .map(idx => candidates[idx])
    .filter(Boolean)
    .map(chunk => ({
      content: chunk.content,
      title: chunk.title,
      scope: chunk.scope || 'global',
      category: chunk.category || 'geral',
    }));

  // Log debug dos chunks finais
  debugInfo.topChunksAfterRerank = results.map(r => ({
    title: r.title,
    category: r.category,
  }));
  console.log(`   Final chunks: ${results.map(r => r.title || 'untitled').join(', ')}`);

  console.log(`✅ RAG retrieval complete: ${results.length} chunks`);
  return results;
}

// =============================================================================
// FORMATAÇÃO DO CONTEXTO RAG
// =============================================================================

/**
 * Formata contexto RAG para injeção no system prompt
 */
export function formatRAGContext(contexts: RAGContext[]): string {
  if (contexts.length === 0) {
    return '';
  }

  let formatted = `
## BASE DE CONHECIMENTO (USE OBRIGATORIAMENTE)
Os seguintes documentos contêm informações VERIFICADAS. Use-os para responder:

`;

  for (const ctx of contexts) {
    const scopeTag = ctx.scope === 'product' ? '🏷️ PRODUTO' : '🌐 GERAL';
    formatted += `---
### ${scopeTag} | ${ctx.category.toUpperCase()}${ctx.title ? ` | ${ctx.title}` : ''}
${ctx.content}

`;
  }

  formatted += `
⚠️ REGRA ANTI-ALUCINAÇÃO (PRIORIDADE MÁXIMA):
Se a informação NÃO estiver nos documentos acima, responda:
"Não tenho essa informação confirmada. Posso verificar com nossa equipe e retornar."

NUNCA invente preços, prazos, links ou dados que não estejam explicitamente documentados.
`;

  return formatted;
}
