import { supabase } from '../lib/supabase.js';
import { env } from '../config/env.js';

// Tipos
interface KnowledgeChunk {
  content: string;
  title?: string;
  scope?: 'product' | 'global';
  category?: string;
  similarity?: number;
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

// Configuracoes
const VOYAGE_API_URL = 'https://api.voyageai.com/v1';
const EMBEDDING_MODEL = 'voyage-3';        // 1024 dimensoes
const RERANK_MODEL = 'rerank-2';
const CANDIDATE_COUNT = 30;                 // Buscar 30 candidatos
const LOW_THRESHOLD = 0.30;                 // Threshold baixo para maximizar pool
const EMERGENCY_THRESHOLD = 0.20;           // Fallback de emergencia
const TOP_K_AFTER_RERANK = 5;               // Top 5 apos rerank

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
        input_type: 'query',  // Otimizado para buscas
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Voyage embedding error:', error);
      return null;
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;

    if (!embedding) {
      console.error('❌ No embedding in response');
      return null;
    }

    // Validar dimensoes (DEVE ser 1024 para voyage-3)
    if (embedding.length !== 1024) {
      console.error(`❌ Embedding dimension mismatch: got ${embedding.length}, expected 1024`);
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

  // Se poucos documentos, nao precisa rerankar
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
      // Fallback: retorna primeiros documentos
      return documents.slice(0, topK).map((_, i) => i);
    }

    const data = await response.json();
    const results: RerankResult[] = data.data || [];

    // Retorna indices dos documentos mais relevantes
    return results.map(r => r.index);
  } catch (error) {
    console.error('❌ Error reranking:', error);
    return documents.slice(0, topK).map((_, i) => i);
  }
}

/**
 * Detecta produto mencionado no texto
 */
export function detectProductInMessage(
  messageText: string,
  products: Product[]
): string | null {
  const messageLower = messageText.toLowerCase();

  for (const product of products) {
    // Verifica nome do produto
    if (product.name && messageLower.includes(product.name.toLowerCase())) {
      return product.id;
    }

    // Verifica slug
    if (product.slug && messageLower.includes(product.slug.toLowerCase())) {
      return product.id;
    }

    // Variacoes (sem hifen, com espaco)
    if (product.slug) {
      const variations = [
        product.slug.replace(/-/g, ' '),
        product.slug.replace(/-/g, ''),
      ];
      for (const variation of variations) {
        if (messageLower.includes(variation.toLowerCase())) {
          return product.id;
        }
      }
    }
  }

  return null;
}

/**
 * Busca conhecimento no Supabase
 */
async function searchKnowledge(
  embedding: number[],
  organizationId: string,
  productId: string | null
): Promise<KnowledgeChunk[]> {
  let candidates: KnowledgeChunk[] = [];

  try {
    // CASO 1: Sem produto detectado -> busca em TODO conhecimento
    if (!productId) {
      const { data: allResults, error } = await supabase.rpc('search_knowledge_all', {
        query_embedding: embedding,
        org_id: organizationId,
        match_threshold: LOW_THRESHOLD,
        match_count: CANDIDATE_COUNT,
      });

      if (error) {
        console.error('❌ search_knowledge_all error:', error);
      } else {
        candidates = allResults || [];
      }
    }
    // CASO 2: Com produto -> busca product-first + global fallback
    else {
      // Passo 1: Chunks especificos do produto
      const { data: productResults, error: productError } = await supabase.rpc('search_knowledge_product', {
        query_embedding: embedding,
        org_id: organizationId,
        p_product_id: productId,
        p_categories: null,
        match_threshold: LOW_THRESHOLD,
        match_count: CANDIDATE_COUNT,
      });

      if (productError) {
        console.error('❌ search_knowledge_product error:', productError);
      } else {
        candidates = productResults || [];
      }

      // Passo 2: Completa com chunks globais se necessario
      if (candidates.length < CANDIDATE_COUNT) {
        const remaining = CANDIDATE_COUNT - candidates.length;
        const { data: globalResults, error: globalError } = await supabase.rpc('search_knowledge_global', {
          query_embedding: embedding,
          org_id: organizationId,
          p_categories: null,
          match_threshold: LOW_THRESHOLD,
          match_count: remaining,
        });

        if (globalError) {
          console.error('❌ search_knowledge_global error:', globalError);
        } else if (globalResults) {
          candidates.push(...globalResults);
        }
      }
    }

    // Fallback de emergencia (threshold ainda mais baixo)
    if (candidates.length === 0) {
      console.log('⚠️ No candidates found, trying emergency fallback...');
      const { data: fallbackResults, error: fallbackError } = await supabase.rpc('search_knowledge_all', {
        query_embedding: embedding,
        org_id: organizationId,
        match_threshold: EMERGENCY_THRESHOLD,
        match_count: CANDIDATE_COUNT,
      });

      if (fallbackError) {
        console.error('❌ search_knowledge_all fallback error:', fallbackError);
      } else {
        candidates = fallbackResults || [];
      }
    }

    console.log(`📚 Found ${candidates.length} knowledge candidates`);
    return candidates;

  } catch (error) {
    console.error('❌ Error searching knowledge:', error);
    return [];
  }
}

/**
 * Busca produtos ativos da organizacao
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
 * Extrai contexto das ultimas mensagens do usuario (apenas inbound)
 */
export function extractSearchContext(
  currentMessage: string,
  messageHistory: Array<{ content?: string; direction: string }>
): string {
  // Apenas mensagens INBOUND (do usuario) - evita poluicao do assistente
  const recentUserMessages = messageHistory
    .filter(m => m.direction === 'inbound')
    .slice(-3)
    .map(m => m.content || '')
    .filter(c => c.trim() !== '')
    .join(' ');

  // Prioriza mensagem atual; adiciona contexto se msg atual for curta
  if (currentMessage.length < 50 && recentUserMessages) {
    return `${recentUserMessages} ${currentMessage}`;
  }

  return currentMessage;
}

/**
 * Funcao principal: busca contexto relevante para RAG
 */
export async function getRelevantContext(
  message: string,
  organizationId: string,
  messageHistory: Array<{ content?: string; direction: string }> = []
): Promise<RAGContext[]> {
  console.log('🔍 Starting RAG retrieval...');

  // 1. Buscar produtos da organizacao
  const products = await getOrganizationProducts(organizationId);
  console.log(`   Found ${products.length} products`);

  // 2. Detectar produto na mensagem atual
  let detectedProductId = detectProductInMessage(message, products);

  // Se nao encontrou, verifica ultimas 5 mensagens do historico
  if (!detectedProductId && messageHistory.length > 0) {
    const recentMessages = messageHistory.slice(-5).reverse();
    for (const msg of recentMessages) {
      if (msg.content) {
        const detected = detectProductInMessage(msg.content, products);
        if (detected) {
          detectedProductId = detected;
          break;
        }
      }
    }
  }

  if (detectedProductId) {
    const product = products.find(p => p.id === detectedProductId);
    console.log(`   Detected product: ${product?.name || detectedProductId}`);
  }

  // 3. Extrair contexto de busca
  const searchContext = extractSearchContext(message, messageHistory);
  console.log(`   Search context: "${searchContext.substring(0, 100)}..."`);

  // 4. Gerar embedding
  const embedding = await generateEmbedding(searchContext);
  if (!embedding) {
    console.error('❌ Failed to generate embedding');
    return [];
  }
  console.log('   Embedding generated (1024 dims)');

  // 5. Buscar candidatos no Supabase
  const candidates = await searchKnowledge(embedding, organizationId, detectedProductId);
  if (candidates.length === 0) {
    console.log('⚠️ No knowledge candidates found');
    return [];
  }

  // 6. Rerankar resultados
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

  console.log(`✅ RAG retrieval complete: ${results.length} chunks`);
  return results;
}

/**
 * Formata contexto RAG para injecao no system prompt
 */
export function formatRAGContext(contexts: RAGContext[]): string {
  if (contexts.length === 0) {
    return '';
  }

  let formatted = `
## BASE DE CONHECIMENTO (USE OBRIGATORIAMENTE)
Os seguintes documentos contem informacoes VERIFICADAS. Use-os para responder:

`;

  for (const ctx of contexts) {
    const scopeTag = ctx.scope === 'product' ? '🏷️ PRODUTO' : '🌐 GERAL';
    formatted += `---
### ${scopeTag} | ${ctx.category.toUpperCase()}${ctx.title ? ` | ${ctx.title}` : ''}
${ctx.content}

`;
  }

  formatted += `
⚠️ REGRA ANTI-ALUCINACAO (PRIORIDADE MAXIMA):
Se a informacao NAO estiver nos documentos acima, responda:
"Nao tenho essa informacao confirmada. Posso verificar com nossa equipe e retornar."

NUNCA invente precos, prazos, especificacoes ou dados que nao estejam explicitamente documentados.
`;

  return formatted;
}
