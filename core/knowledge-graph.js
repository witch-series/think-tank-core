'use strict';

const fs = require('fs');
const path = require('path');
const { fillPrompt } = require('../lib/prompt-loader');
const { parseJsonSafe } = require('../lib/json-parser');
const { getModelConfig } = require('../lib/model-config');

const GRAPH_PATH = path.join(__dirname, '..', 'brain', 'knowledge-graph.json');

// --- Shared keyword quality filter ---
// Used both at insertion (updateGraph) and pruning (pruneGraph) to prevent
// generic/junk keywords from entering or persisting in the graph.

const JUNK_PATTERN = /^[\d\s\-_.,:;!?@#$%^&*()=+\[\]{}|\\/<>~`'"…→←↑↓●■▲▼◆★※]+$/;

const TOO_GENERIC_JA = new Set([
  // 抽象的な概念
  '情報', '技術', 'システム', 'データ', '処理', '方法', '開発', '研究', '最新', '動向',
  '概要', 'まとめ', 'その他', '関連', '結果', '内容', '分析', '評価', '特徴', '機能',
  '環境', '構造', '設計', '実装', '確認', '対応', '管理', '利用', '活用', '提供',
  '実現', '向上', '改善', '問題', '課題', '目的', '背景', '理由', '意味', '定義',
  '説明', '解説', '紹介', '比較', '検討', '考察', '観点', '視点', '側面', '要素',
  // 一般動詞・形容詞由来
  '対策', '注意', '重要', '必要', '可能', '有効', '基本', '応用', '実践', '具体的',
  '効果', '影響', '変化', '進化', '成長', '発展', '将来', '今後', '現在', '最近',
  '世界', '日本', '海外', '国内', '企業', '事例', '例', '種類', '一覧', 'リスト',
  // ウェブ・記事由来
  'サイト', 'ページ', '記事', 'ブログ', 'ニュース', 'レポート', 'ガイド', '入門',
  '初心者', '上級者', 'おすすめ', 'ランキング', '人気', '話題', 'トレンド', '注目',
  '選び方', '使い方', 'やり方', '始め方', '作り方', 'メリット', 'デメリット',
  'ポイント', 'コツ', 'まとめ記事', '徹底解説', '完全ガイド',
  // 数量・程度
  '多く', '少ない', '高い', '低い', '大きい', '小さい', '良い', '悪い',
  '全体', '部分', '一部', '主要', '代表的', '典型的', '一般的', '特殊',
  // 一般的な技術用語（固有名詞ではない）
  '予測', '最適化', '速度', 'コスト', '信頼性', 'セキュリティ', 'ロボット',
  '不確実性', '精度', '性能', '推論', '学習', '検出', '認識', '生成', '変換',
  '統合', '自動化', '可視化', '抽出', '分類', '計算', '接続', '通信', '制御',
  '予測市場', '実験実行', '材料設計', '動作解析', 'テストケース',
  // 分野名そのもの
  '機械学習', 'ディープラーニング', 'コンピュータビジョン', '自然言語処理',
  'ニューラルネットワーク', '強化学習', '人工知能', 'ロボティクス',
  'サイバーセキュリティ', 'データサイエンス', 'クラウドコンピューティング',
  // 曖昧なフレーズ
  '汎化能力', '汎化問題', 'データ効率', '計算コスト', '計算コスト削減',
  '推論速度', '推論一貫性', '視覚的変更', 'ビデオコンテンツ',
  '多様な状況下', '高精度', '高感度', '広い視野', 'リアルタイム処理',
  'データ収集計画', '評価コスト', '後続効果', '長期ホライズン',
  'マルチモーダル', '大規模データ', 'モデル予測制御'
]);

const TOO_GENERIC_EN = new Set([
  'the', 'a', 'an', 'and', 'or', 'for', 'with', 'from', 'this', 'that', 'these', 'those',
  'about', 'into', 'over', 'after', 'before', 'between', 'through', 'during', 'without',
  'data', 'system', 'method', 'information', 'technology', 'result', 'feature', 'overview',
  'summary', 'update', 'other', 'general', 'basic', 'simple', 'main', 'common', 'standard',
  'example', 'case', 'type', 'kind', 'list', 'guide', 'introduction', 'tutorial',
  'approach', 'solution', 'issue', 'problem', 'challenge', 'benefit', 'advantage',
  'process', 'step', 'way', 'part', 'area', 'level', 'point', 'factor', 'aspect',
  'new', 'latest', 'best', 'top', 'good', 'great', 'important', 'key', 'major',
  'modern', 'advanced', 'popular', 'various', 'different', 'specific', 'related',
  'current', 'recent', 'future', 'next', 'first', 'last', 'many', 'most', 'some',
  'use', 'using', 'used', 'based', 'make', 'build', 'create', 'work', 'working',
  'change', 'improve', 'development', 'management', 'analysis', 'review', 'comparison',
  'blog', 'post', 'article', 'news', 'report', 'page', 'site', 'website', 'link',
  'tips', 'tricks', 'how', 'why', 'what', 'which', 'when', 'where', 'who',
  'beginner', 'beginners', 'getting', 'started', 'everything', 'complete', 'ultimate',
  'prediction', 'optimization', 'speed', 'cost', 'reliability', 'security', 'robot',
  'uncertainty', 'accuracy', 'performance', 'inference', 'learning', 'detection',
  'recognition', 'generation', 'transformation', 'integration', 'automation',
  'visualization', 'extraction', 'classification', 'computation', 'communication',
  'control', 'model', 'framework', 'architecture', 'pipeline', 'module', 'platform',
  'tool', 'training', 'evaluation', 'benchmark', 'dataset', 'experiment',
  'machine learning', 'deep learning', 'computer vision', 'natural language processing',
  'neural network', 'neural networks', 'reinforcement learning', 'artificial intelligence',
  'robotics', 'cybersecurity', 'data science', 'cloud computing'
]);

const GENERIC_PHRASE_PATTERNS = [
  /^.{2,}の(削減|向上|改善|最適化|自動化|効率化|高速化|安定化|強化|拡張|統合|実現|活用|確保|評価|分析|処理|管理|制御|検出|生成|変換|推定|予測|解析|構築|設計|実装|導入|運用)$/,
  /^(高|低|大|小|長|短|多|新|旧)(精度|速度|性能|効率|品質|信頼性|可用性|安定性|柔軟性|拡張性|堅牢性)$/,
  /^.{2,}(ベース|ベースの|に基づく|による|のための|についての|における|に関する)$/,
  /^(リアルタイム|大規模|高性能|低コスト|高効率|次世代)(処理|制御|データ|システム|環境|モデル|計算|解析|推論|学習|最適化|変換|生成|検出|分析|評価|管理|統合|自動化|可視化|群制御|群の制御|スワーム制御|スワーム|言語モデル)$/,
];

/**
 * Check if a label is too generic / junk to be a knowledge graph keyword.
 * Returns true if the label should be REJECTED.
 */
function isGenericLabel(label) {
  if (!label || label.length <= 1) return true;
  if (JUNK_PATTERN.test(label)) return true;
  if (TOO_GENERIC_JA.has(label)) return true;
  if (TOO_GENERIC_EN.has(label.toLowerCase())) return true;
  if (GENERIC_PHRASE_PATTERNS.some(p => p.test(label))) return true;
  // Purely short hiragana/katakana (not proper nouns)
  if (/^[\u3040-\u309f\u30a0-\u30ff]{1,6}$/.test(label) && !/[A-Za-z0-9\u4e00-\u9fff]/.test(label)) return true;
  return false;
}

function loadGraph() {
  try {
    if (fs.existsSync(GRAPH_PATH)) return JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf-8'));
  } catch {}
  return { nodes: {}, edges: [], processedTimestamps: [] };
}

function saveGraph(graph) {
  const dir = path.dirname(GRAPH_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(GRAPH_PATH, JSON.stringify(graph, null, 2), 'utf-8');
}

/**
 * Extract keywords from research results via LLM and update the graph.
 */
async function updateGraph(client, entry) {
  const graph = loadGraph();

  const topic = entry.topic || '';
  const summary = entry.summary || '';
  const insights = Array.isArray(entry.insights) ? entry.insights.join('\n') : '';
  const sources = Array.isArray(entry.sources) ? entry.sources.join('\n') : '';

  if (!summary && !insights) return graph;

  const prompt = fillPrompt('extract-keywords.user', { topic, summary, insights, sources });

  let keywords = [];
  let relations = [];

  try {
    const { parsed } = await client.queryForJson(prompt, 'JSONのみ出力してください。');
    if (parsed) {
      keywords = Array.isArray(parsed.keywords) ? parsed.keywords : [];
      relations = Array.isArray(parsed.relations) ? parsed.relations : [];
    }
  } catch {
    return graph;
  }

  const now = new Date().toISOString();
  const entrySources = Array.isArray(entry.sources) ? entry.sources : [];

  // Update nodes — filter out generic keywords before insertion
  for (const kw of keywords) {
    const key = normalizeKey(kw.keyword);
    if (!key) continue;
    // Gate: reject generic/junk keywords at insertion time
    if (isGenericLabel((kw.keyword || '').trim())) continue;

    if (graph.nodes[key]) {
      // Existing node — merge data
      const node = graph.nodes[key];
      node.count = (node.count || 1) + 1;
      node.lastUpdated = now;
      if (kw.description && (!node.description || kw.description.length > node.description.length)) {
        node.description = kw.description;
      }
      if (kw.importance > (node.importance || 0)) {
        node.importance = kw.importance;
      }
      if (kw.category && !node.category) {
        node.category = kw.category;
      }
      // Add new sources
      const srcSet = new Set(node.sources || []);
      for (const s of entrySources) srcSet.add(s);
      node.sources = [...srcSet].slice(0, 20);
      // Track related topics
      const topicSet = new Set(node.topics || []);
      if (topic) topicSet.add(topic);
      node.topics = [...topicSet].slice(0, 10);
    } else {
      // New node
      graph.nodes[key] = {
        label: kw.keyword,
        description: kw.description || '',
        category: kw.category || '',
        importance: kw.importance || 1,
        count: 1,
        sources: entrySources.slice(0, 20),
        topics: topic ? [topic] : [],
        firstSeen: now,
        lastUpdated: now
      };
    }
  }

  // Update edges from LLM-extracted relations
  // Build edge lookup for fast duplicate check
  const edgeSet = new Set(graph.edges.map(e => [e.from, e.to].sort().join('|')));

  function addOrStrengthEdge(fromKey, toKey, relation) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    if (!graph.nodes[fromKey] || !graph.nodes[toKey]) return;
    const pairKey = [fromKey, toKey].sort().join('|');
    if (edgeSet.has(pairKey)) {
      const existing = graph.edges.find(e =>
        (e.from === fromKey && e.to === toKey) || (e.from === toKey && e.to === fromKey)
      );
      if (existing) {
        existing.weight = (existing.weight || 1) + 1;
        if (relation) existing.relation = relation;
      }
    } else {
      graph.edges.push({ from: fromKey, to: toKey, relation: relation || '', weight: 1 });
      edgeSet.add(pairKey);
    }
  }

  for (const rel of relations) {
    addOrStrengthEdge(normalizeKey(rel.from), normalizeKey(rel.to), rel.relation);
  }

  // Auto-connect: all keywords extracted from the same research are related
  // (they co-occurred in the same document/topic)
  const acceptedKeys = keywords
    .map(kw => normalizeKey(kw.keyword))
    .filter(k => k && graph.nodes[k]);

  for (let i = 0; i < acceptedKeys.length; i++) {
    for (let j = i + 1; j < acceptedKeys.length; j++) {
      addOrStrengthEdge(acceptedKeys[i], acceptedKeys[j], `同一リサーチ: ${topic.slice(0, 40)}`);
    }
  }

  // Track processed entry by timestamp to avoid re-processing
  if (!graph.processedTimestamps) graph.processedTimestamps = [];
  if (entry.timestamp) graph.processedTimestamps.push(entry.timestamp);
  // Keep only last 500 timestamps
  if (graph.processedTimestamps.length > 500) {
    graph.processedTimestamps = graph.processedTimestamps.slice(-500);
  }

  saveGraph(graph);
  return graph;
}

/**
 * Review and reorganize the entire graph via LLM.
 * Merges duplicates, assigns categories, fixes connections.
 */
async function reviewGraph(client, onLog, options = {}) {
  const queryOpts = options.model ? { model: options.model } : {};
  const goalPrompt = options.goalPrompt || '';
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 2) {
    if (onLog) onLog('info', `Graph review skipped: only ${keys.length} nodes`);
    return graph;
  }

  if (onLog) onLog('info', `Reviewing knowledge graph (${keys.length} nodes, ${graph.edges.length} edges)`);

  // Determine batch size based on model capability
  const modelConfig = getModelConfig(options.ollamaConfig || { model: client.model });
  const reviewBatchSize = modelConfig.reviewBatchSize;

  // Helper: apply a single review result to the graph
  function applyReviewResult(result) {
    let mergeCount = 0, addCount = 0, removeCount = 0;

    const merges = Array.isArray(result.merge) ? result.merge : [];
    const mergedFromKeys = new Set();
    for (const m of merges) {
      const fromKey = normalizeKey(m.from);
      const intoKey = normalizeKey(m.into);
      if (!fromKey || !intoKey || fromKey === intoKey) continue;
      if (!graph.nodes[fromKey] || !graph.nodes[intoKey]) continue;

      const src = graph.nodes[fromKey];
      const dst = graph.nodes[intoKey];
      dst.count = (dst.count || 1) + (src.count || 1);
      const srcSet = new Set([...(dst.sources || []), ...(src.sources || [])]);
      dst.sources = [...srcSet].slice(0, 20);
      const topicSet = new Set([...(dst.topics || []), ...(src.topics || [])]);
      dst.topics = [...topicSet].slice(0, 10);
      if (src.description && src.description.length > (dst.description || '').length) {
        dst.description = src.description;
      }
      dst.lastUpdated = new Date().toISOString();

      for (const edge of graph.edges) {
        if (edge.from === fromKey) edge.from = intoKey;
        if (edge.to === fromKey) edge.to = intoKey;
      }
      mergedFromKeys.add(fromKey);
      delete graph.nodes[fromKey];
      if (onLog) onLog('debug', `Graph merge: ${m.from} → ${m.into}`);
      mergeCount++;
    }
    // Batch self-loop removal after all merges
    if (mergedFromKeys.size > 0) {
      graph.edges = graph.edges.filter(e => e.from !== e.to);
    }

    const categories = result.categories || {};
    for (const [label, category] of Object.entries(categories)) {
      const key = normalizeKey(label);
      if (graph.nodes[key]) graph.nodes[key].category = category;
    }

    const addEdges = Array.isArray(result.addEdges) ? result.addEdges : [];
    // Build edge lookup set for fast duplicate check
    const existingEdgeSet = new Set(
      graph.edges.map(e => [e.from, e.to].sort().join('|'))
    );
    for (const e of addEdges) {
      const fromKey = normalizeKey(e.from);
      const toKey = normalizeKey(e.to);
      if (!fromKey || !toKey || fromKey === toKey) continue;
      if (!graph.nodes[fromKey] || !graph.nodes[toKey]) continue;
      const pairKey = [fromKey, toKey].sort().join('|');
      if (!existingEdgeSet.has(pairKey)) {
        graph.edges.push({ from: fromKey, to: toKey, relation: e.relation || '', weight: 1 });
        existingEdgeSet.add(pairKey);
        addCount++;
      }
    }

    const removeEdges = Array.isArray(result.removeEdges) ? result.removeEdges : [];
    if (removeEdges.length > 0) {
      // Batch edge removal — collect all pairs to remove, then single filter pass
      const removePairs = new Set();
      for (const e of removeEdges) {
        const fromKey = normalizeKey(e.from);
        const toKey = normalizeKey(e.to);
        removePairs.add([fromKey, toKey].sort().join('|'));
        removeCount++;
      }
      graph.edges = graph.edges.filter(ex => {
        const pairKey = [ex.from, ex.to].sort().join('|');
        return !removePairs.has(pairKey);
      });
    }

    return { mergeCount, addCount, removeCount };
  }

  try {
    let totalMerges = 0, totalAdds = 0, totalRemoves = 0;

    // Split into batches for small models
    const batches = [];
    for (let i = 0; i < keys.length; i += reviewBatchSize) {
      batches.push(keys.slice(i, i + reviewBatchSize));
    }

    for (const batchKeys of batches) {
      const nodeList = batchKeys.map(k => {
        const n = graph.nodes[k];
        if (!n) return null;
        return `- ${n.label} (${n.count || 1}回, カテゴリ: ${n.category || '未分類'}): ${(n.description || '').slice(0, 80)}`;
      }).filter(Boolean).join('\n');

      // Include only edges relevant to this batch
      const batchKeySet = new Set(batchKeys);
      const edgeList = graph.edges
        .filter(e => batchKeySet.has(e.from) || batchKeySet.has(e.to))
        .map(e => {
          const fromLabel = graph.nodes[e.from]?.label || e.from;
          const toLabel = graph.nodes[e.to]?.label || e.to;
          return `- ${fromLabel} → ${toLabel}: ${e.relation || '関連'} (重み: ${e.weight || 1})`;
        }).join('\n') || 'なし';

      const prompt = fillPrompt('review-graph.user', { nodeList, edgeList, goalPrompt: goalPrompt || 'なし' });
      const { parsed: result } = await client.queryForJson(prompt, 'JSONのみ出力してください。', queryOpts);
      if (result) {
        const counts = applyReviewResult(result);
        totalMerges += counts.mergeCount;
        totalAdds += counts.addCount;
        totalRemoves += counts.removeCount;
      }
    }

    // Deduplicate edges (same from/to pair)
    const edgeMap = new Map();
    for (const e of graph.edges) {
      const pairKey = [e.from, e.to].sort().join('|');
      if (edgeMap.has(pairKey)) {
        edgeMap.get(pairKey).weight = (edgeMap.get(pairKey).weight || 1) + (e.weight || 1);
      } else {
        edgeMap.set(pairKey, e);
      }
    }
    graph.edges = [...edgeMap.values()];

    saveGraph(graph);

    const newKeys = Object.keys(graph.nodes);
    if (onLog) onLog('info', `Graph review done: ${newKeys.length} nodes, ${graph.edges.length} edges (merged ${totalMerges}, +${totalAdds} edges, -${totalRemoves} edges)`);
  } catch (e) {
    if (onLog) onLog('debug', `Graph review failed: ${e.message}`);
  }

  return graph;
}

/**
 * Process knowledge entries that haven't been indexed into the graph yet.
 * Called on startup to catch up on unprocessed data.
 */
async function processUnindexedEntries(client, knowledgeDbPaths, onLog) {
  const graph = loadGraph();
  const processed = new Set(graph.processedTimestamps || []);

  // Collect all entries from all knowledge DBs
  const unprocessed = [];
  for (const dbPath of knowledgeDbPaths) {
    if (!fs.existsSync(dbPath)) continue;
    const files = fs.readdirSync(dbPath).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const lines = fs.readFileSync(path.join(dbPath, file), 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.timestamp && !processed.has(entry.timestamp)) {
            const hasContent = (entry.summary && entry.summary.length > 10) ||
                               (Array.isArray(entry.insights) && entry.insights.length > 0);
            if (hasContent) unprocessed.push(entry);
          }
        } catch {}
      }
    }
  }

  if (unprocessed.length === 0) {
    if (onLog) onLog('debug', 'Knowledge graph: all entries already indexed');
    return 0;
  }

  if (onLog) onLog('info', `Knowledge graph: indexing ${unprocessed.length} unprocessed entries...`);

  let indexed = 0;
  for (const entry of unprocessed) {
    try {
      await updateGraph(client, entry);
      indexed++;
      if (indexed % 5 === 0 && onLog) {
        onLog('debug', `Graph indexing progress: ${indexed}/${unprocessed.length}`);
      }
    } catch (e) {
      if (onLog) onLog('debug', `Graph indexing failed for entry: ${e.message}`);
    }
  }

  if (onLog) onLog('info', `Knowledge graph: indexed ${indexed} entries`);
  return indexed;
}

/**
 * Get under-explored keywords — prioritize nodes with few connections and low count.
 */
function getUnderExplored(limit = 10, recentTopics = []) {
  const graph = loadGraph();
  const nodes = Object.entries(graph.nodes);
  if (nodes.length === 0) return [];

  // Count edges per node
  const edgeCounts = {};
  for (const [key] of nodes) edgeCounts[key] = 0;
  for (const e of graph.edges) {
    if (edgeCounts[e.from] !== undefined) edgeCounts[e.from]++;
    if (edgeCounts[e.to] !== undefined) edgeCounts[e.to]++;
  }

  // Build a set of recently searched labels (lowercase) for penalty
  const recentLower = recentTopics.map(t => t.toLowerCase());

  const now = Date.now();
  const scored = nodes.map(([key, node]) => {
    const age = (now - new Date(node.lastUpdated || node.firstSeen).getTime()) / (1000 * 60 * 60);
    const connections = edgeCounts[key] || 0;
    const count = node.count || 1;
    const label = (node.label || '').toLowerCase();

    // Penalize keywords that appear in recent search topics
    const recentPenalty = recentLower.some(t => t.includes(label) || label.includes(t)) ? 0.01 : 1;
    // Penalize over-researched keywords (diminishing returns beyond 10)
    const countPenalty = 1 / (1 + Math.log2(count));

    const score = (1 / (connections + 1)) * countPenalty * (1 + age / 24) * recentPenalty;
    return { key, label: node.label, description: node.description, category: node.category || '', count, connections, score };
  });

  scored.sort((a, b) => b.score - a.score);

  // Ensure category diversity: don't return more than 2 from same category
  const result = [];
  const catCount = {};
  for (const item of scored) {
    if (result.length >= limit) break;
    const cat = item.category || 'other';
    catCount[cat] = (catCount[cat] || 0) + 1;
    if (catCount[cat] <= 2) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Get weakly-connected keyword pairs: pick isolated nodes and suggest
 * a well-connected node to search together, so the LLM can find bridges.
 */
function getSuggestedSearchPairs(limit = 3, recentTopics = []) {
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 4) return [];

  // Count edges per node
  const edgeCounts = {};
  for (const k of keys) edgeCounts[k] = 0;
  for (const e of graph.edges) {
    if (edgeCounts[e.from] !== undefined) edgeCounts[e.from]++;
    if (edgeCounts[e.to] !== undefined) edgeCounts[e.to]++;
  }

  const recentLower = recentTopics.map(t => t.toLowerCase());
  function isRecent(k) {
    const label = (graph.nodes[k]?.label || '').toLowerCase();
    return recentLower.some(t => t.includes(label) || label.includes(t));
  }

  // Separate weak (0-2 edges) and strong (3+ edges), excluding recently searched
  // Expanded threshold from 0-1 to 0-2 to be more aggressive about connecting nodes
  const weak = keys.filter(k => edgeCounts[k] <= 2 && !isRecent(k))
    .sort((a, b) => (edgeCounts[a] || 0) - (edgeCounts[b] || 0)); // least connected first
  const strong = keys.filter(k => edgeCounts[k] >= 2)
    .sort((a, b) => (edgeCounts[b] || 0) - (edgeCounts[a] || 0));

  if (weak.length === 0 || strong.length === 0) return [];

  // Build connected set for quick lookup
  const connected = new Set();
  for (const e of graph.edges) connected.add(e.from + '|' + e.to);

  // Try to pair weak nodes with strong nodes from DIFFERENT categories
  const pairs = [];
  const usedCategories = new Set();
  for (const w of weak) {
    if (pairs.length >= limit) break;
    const wCat = graph.nodes[w]?.category || '';
    if (usedCategories.has(wCat) && wCat) continue; // different categories each time

    const partner = strong.find(s => {
      if (connected.has(w + '|' + s) || connected.has(s + '|' + w)) return false;
      if (isRecent(s)) return false;
      // Prefer different category for cross-domain discovery
      const sCat = graph.nodes[s]?.category || '';
      return sCat !== wCat || !wCat;
    }) || strong.find(s =>
      !connected.has(w + '|' + s) && !connected.has(s + '|' + w) && !isRecent(s)
    );

    if (partner) {
      pairs.push({
        weak: graph.nodes[w].label,
        strong: graph.nodes[partner].label,
        weakConnections: edgeCounts[w],
        strongConnections: edgeCounts[partner]
      });
      if (wCat) usedCategories.add(wCat);
    }
  }
  return pairs;
}

/**
 * Calculate a numeric score for the graph's quality/growth.
 * Higher = more developed knowledge graph.
 * Components: node count, edge count, connectivity density, category diversity.
 */
function calculateGraphScore() {
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  const nodeCount = keys.length;
  const edgeCount = graph.edges.length;
  if (nodeCount === 0) return { score: 0, nodeCount: 0, edgeCount: 0, density: 0, categories: 0 };

  // Connectivity density: average edges per node
  const density = nodeCount > 0 ? edgeCount / nodeCount : 0;

  // Category diversity: number of unique categories
  const cats = new Set(keys.map(k => graph.nodes[k].category).filter(Boolean));
  const categories = cats.size;

  // Score formula: weighted combination
  // - Nodes contribute linearly (10 pts each)
  // - Edges contribute (5 pts each, encourages connections)
  // - Density bonus (up to 50 pts, encourages well-connected graph)
  // - Category diversity bonus (20 pts per category, encourages breadth)
  const score = Math.round(
    nodeCount * 10 +
    edgeCount * 5 +
    Math.min(density, 5) * 10 +
    categories * 20
  );

  return { score, nodeCount, edgeCount, density: Math.round(density * 100) / 100, categories };
}

const SCORE_HISTORY_PATH = path.join(__dirname, '..', 'brain', 'graph-score-history.json');

/**
 * Record current graph score and return stagnation analysis.
 * Keeps last 20 scores. Returns whether the graph is stagnating.
 */
function recordAndAnalyzeScore() {
  const current = calculateGraphScore();
  let history = [];
  try {
    if (fs.existsSync(SCORE_HISTORY_PATH)) {
      history = JSON.parse(fs.readFileSync(SCORE_HISTORY_PATH, 'utf-8'));
    }
  } catch {}

  history.push({ score: current.score, timestamp: new Date().toISOString(), ...current });
  if (history.length > 20) history = history.slice(-20);
  fs.writeFileSync(SCORE_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8');

  // Analyze stagnation: compare last 3 scores
  let stagnant = false;
  let scoreChange = 0;
  let recentScores = '';
  if (history.length >= 3) {
    const last3 = history.slice(-3);
    const oldest = last3[0].score;
    const newest = last3[2].score;
    scoreChange = newest - oldest;
    // Stagnant if score changed by less than 5% over last 3 cycles
    stagnant = oldest > 0 && Math.abs(scoreChange) / oldest < 0.05;
    recentScores = last3.map(h => String(h.score)).join(' → ');
  } else {
    recentScores = history.map(h => String(h.score)).join(' → ');
  }

  return {
    ...current,
    stagnant,
    scoreChange,
    recentScores,
    historyLength: history.length
  };
}

/**
 * Get graph stats for planning prompt.
 */
function getGraphStats(recentTopics = []) {
  const graph = loadGraph();
  const nodeCount = Object.keys(graph.nodes).length;
  const edgeCount = graph.edges.length;
  if (nodeCount === 0) return { nodeCount: 0, edgeCount: 0, underExplored: '', topKeywords: '', searchSuggestions: '', score: 0, stagnant: false, scoreChange: 0, recentScores: '', categories: 0, overResearched: '' };

  const scoreAnalysis = recordAndAnalyzeScore();

  const underExplored = getUnderExplored(5, recentTopics)
    .map(n => `${n.label}(調査${n.count}回/接続${n.connections})`)
    .join(', ');

  const topKeywords = Object.entries(graph.nodes)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 5)
    .map(([, n]) => `${n.label}(${n.count}回)`)
    .join(', ');

  // Identify over-researched keywords (count > 20) to warn the planner
  const overResearched = Object.entries(graph.nodes)
    .filter(([, n]) => (n.count || 0) > 20)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 5)
    .map(([, n]) => `${n.label}(${n.count}回)`)
    .join(', ');

  const pairs = getSuggestedSearchPairs(3, recentTopics);
  const searchSuggestions = pairs.length > 0
    ? pairs.map(p => `「${p.weak}」と「${p.strong}」の関連性`).join(', ')
    : '';

  return {
    nodeCount, edgeCount, underExplored, topKeywords, searchSuggestions, overResearched,
    score: scoreAnalysis.score,
    stagnant: scoreAnalysis.stagnant,
    scoreChange: scoreAnalysis.scoreChange,
    recentScores: scoreAnalysis.recentScores,
    categories: scoreAnalysis.categories,
    density: scoreAnalysis.density
  };
}

/**
 * Get full graph data for API/UI.
 */
function getGraphData() {
  return loadGraph();
}

/**
 * Prune the graph: find and merge similar/duplicate keywords via LLM.
 * Sorts keywords alphabetically so similar words cluster together,
 * then asks LLM to identify duplicates in batches.
 */
async function pruneGraph(client, onLog, options = {}) {
  const queryOpts = options.model ? { model: options.model } : {};
  const goalPrompt = options.goalPrompt || '';
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 2) {
    if (onLog) onLog('info', `Graph prune skipped: only ${keys.length} nodes`);
    return graph;
  }

  // Pre-pass: programmatic fuzzy merge for obvious duplicates
  const prePassMerged = [];

  // Track merged victims for deferred edge cleanup
  const mergedVictims = new Set();

  // Helper: merge victim into keeper (defers self-loop cleanup)
  function mergeNodes(keeper, victim) {
    if (!graph.nodes[victim] || !graph.nodes[keeper]) return false;
    const src = graph.nodes[victim];
    const dst = graph.nodes[keeper];
    dst.count = (dst.count || 1) + (src.count || 1);
    const srcSet = new Set([...(dst.sources || []), ...(src.sources || [])]);
    dst.sources = [...srcSet].slice(0, 20);
    const topicSet = new Set([...(dst.topics || []), ...(src.topics || [])]);
    dst.topics = [...topicSet].slice(0, 10);
    if (src.description && src.description.length > (dst.description || '').length) {
      dst.description = src.description;
    }
    dst.lastUpdated = new Date().toISOString();
    for (const edge of graph.edges) {
      if (edge.from === victim) edge.from = keeper;
      if (edge.to === victim) edge.to = keeper;
    }
    mergedVictims.add(victim);
    prePassMerged.push(src.label || victim);
    delete graph.nodes[victim];
    return true;
  }

  // Normalization functions for grouping
  function normBasic(label) {
    return label.toLowerCase()
      .replace(/[\s\-_\.・、。()（）\[\]]+/g, '')
      .replace(/[^a-z0-9\u3000-\u9fff\uff00-\uffef]/g, '');
  }
  function normNoBrackets(label) {
    // Remove parenthetical content: "LoD (Level of Detail)" → "lod"
    return label.toLowerCase()
      .replace(/\s*[\(（].*?[\)）]/g, '')
      .replace(/[\s\-_\.・、。\[\]]+/g, '')
      .replace(/[^a-z0-9\u3000-\u9fff\uff00-\uffef]/g, '');
  }
  function normSorted(label) {
    // Sort words: "Level of Detail LoD" and "LoD Level of Detail" → same
    return label.toLowerCase()
      .replace(/[\(（\)）\[\]]/g, ' ')
      .split(/[\s\-_\.・、。]+/)
      .filter(Boolean)
      .sort()
      .join('');
  }
  function normSingular(label) {
    // Basic singularization: remove trailing 's'
    return normBasic(label).replace(/s$/, '');
  }

  // Run multiple normalization passes to catch different duplicate patterns
  const normFns = [normBasic, normNoBrackets, normSorted, normSingular];
  const alreadyMerged = new Set();

  for (const normFn of normFns) {
    const groups = new Map();
    for (const k of Object.keys(graph.nodes)) {
      if (alreadyMerged.has(k)) continue;
      const norm = normFn(graph.nodes[k].label || k);
      if (!norm) continue;
      if (!groups.has(norm)) groups.set(norm, []);
      groups.get(norm).push(k);
    }
    for (const [, group] of groups) {
      if (group.length < 2) continue;
      group.sort((a, b) => (graph.nodes[b]?.count || 0) - (graph.nodes[a]?.count || 0));
      const keeper = group[0];
      for (let i = 1; i < group.length; i++) {
        if (mergeNodes(keeper, group[i])) {
          alreadyMerged.add(group[i]);
        }
      }
    }
  }

  // Batch self-loop removal after all pre-pass merges
  if (mergedVictims.size > 0) {
    graph.edges = graph.edges.filter(e => e.from !== e.to);
  }

  if (prePassMerged.length > 0 && onLog) {
    onLog('info', `Pre-pass: auto-merged ${prePassMerged.length} obvious duplicates`);
  }

  // Refresh keys after pre-pass
  let currentKeys = Object.keys(graph.nodes);
  if (currentKeys.length < 2) {
    saveGraph(graph);
    return graph;
  }

  let totalMerged = 0;
  let totalRemoved = 0;
  const removedLabels = [...prePassMerged];

  // Helper: apply LLM prune result to graph (batched edge removal)
  function applyPruneResult(result) {
    const merges = Array.isArray(result.merge) ? result.merge : [];
    for (const m of merges) {
      const fromKey = normalizeKey(m.from);
      const intoKey = normalizeKey(m.into);
      if (!fromKey || !intoKey || fromKey === intoKey) continue;
      if (!graph.nodes[fromKey] || !graph.nodes[intoKey]) continue;
      mergeNodes(intoKey, fromKey);
      totalMerged++;
      if (onLog) onLog('debug', `Prune merge: ${m.from} → ${m.into}${m.reason ? ' (' + m.reason + ')' : ''}`);
    }
    const removes = Array.isArray(result.remove) ? result.remove : [];
    const removedKeys = new Set();
    for (const label of removes) {
      const key = normalizeKey(label);
      if (key && graph.nodes[key]) {
        removedLabels.push(graph.nodes[key].label || label);
        delete graph.nodes[key];
        removedKeys.add(key);
        totalRemoved++;
        if (onLog) onLog('debug', `Prune remove: ${label}`);
      }
    }
    // Batch edge removal — single pass instead of per-node filter
    if (removedKeys.size > 0) {
      graph.edges = graph.edges.filter(e => !removedKeys.has(e.from) && !removedKeys.has(e.to));
    }
  }

  // --- Pre-LLM pruning: remove obviously junk nodes without LLM ---
  const edgeCountsPre = {};
  for (const k of currentKeys) edgeCountsPre[k] = 0;
  for (const e of graph.edges) {
    if (edgeCountsPre[e.from] !== undefined) edgeCountsPre[e.from]++;
    if (edgeCountsPre[e.to] !== undefined) edgeCountsPre[e.to]++;
  }

  const autoRemoveKeys = new Set();
  for (const k of currentKeys) {
    const node = graph.nodes[k];
    if (!node) continue;
    const label = (node.label || k).trim();
    const conn = edgeCountsPre[k] || 0;
    const count = node.count || 1;

    // Remove: generic/junk via shared filter
    if (isGenericLabel(label)) {
      autoRemoveKeys.add(k);
      continue;
    }
    // Remove: isolated nodes with very short labels (likely fragments)
    if (count <= 1 && conn === 0 && label.length <= 3 && !/[A-Z]{2,}/.test(label)) {
      autoRemoveKeys.add(k);
      continue;
    }
  }

  if (autoRemoveKeys.size > 0) {
    for (const k of autoRemoveKeys) {
      removedLabels.push(graph.nodes[k]?.label || k);
      delete graph.nodes[k];
      totalRemoved++;
    }
    graph.edges = graph.edges.filter(e => !autoRemoveKeys.has(e.from) && !autoRemoveKeys.has(e.to));
    currentKeys = Object.keys(graph.nodes);
    if (onLog) onLog('info', `Pre-LLM prune: auto-removed ${autoRemoveKeys.size} junk/generic nodes`);
  }

  // --- Multi-round LLM pruning ---
  const modelConfig = getModelConfig(options.ollamaConfig || { model: client.model });
  const MAX_ROUNDS = modelConfig.pruneMaxRounds;
  const BATCH_SIZE = modelConfig.pruneBatchSize;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    currentKeys = Object.keys(graph.nodes);
    if (currentKeys.length < 2) break;

    // Count edges per node
    const edgeCounts = {};
    for (const k of currentKeys) edgeCounts[k] = 0;
    for (const e of graph.edges) {
      if (edgeCounts[e.from] !== undefined) edgeCounts[e.from]++;
      if (edgeCounts[e.to] !== undefined) edgeCounts[e.to]++;
    }

    // Group keywords by common words (tokens) — similar keywords share tokens
    const tokenToKeys = new Map();
    for (const k of currentKeys) {
      const label = (graph.nodes[k].label || k).toLowerCase();
      // Split on spaces/punctuation for English tokens
      const tokens = label
        .replace(/[\(（\)）\[\]]/g, ' ')
        .split(/[\s\-_\.・、。,]+/)
        .filter(t => t.length >= 2);
      // Extract CJK substrings (3+ chars) as additional tokens
      const cjkMatches = label.match(/[\u3000-\u9fff\uff00-\uffef]{3,}/g);
      if (cjkMatches) tokens.push(...cjkMatches);
      for (const t of tokens) {
        if (!tokenToKeys.has(t)) tokenToKeys.set(t, new Set());
        tokenToKeys.get(t).add(k);
      }
    }

    // Find clusters: groups of keys sharing tokens, sorted by cluster size (largest first)
    const visited = new Set();
    const clusters = [];
    // Sort tokens by how many keys they touch (descending) — prioritize shared words
    const sortedTokens = [...tokenToKeys.entries()]
      .filter(([, keys]) => keys.size >= 2)
      .sort((a, b) => b[1].size - a[1].size);

    for (const [, tokenKeys] of sortedTokens) {
      // Expand cluster: find all keys connected by shared tokens
      const cluster = new Set();
      const queue = [...tokenKeys];
      while (queue.length > 0) {
        const k = queue.pop();
        if (visited.has(k) || cluster.size >= BATCH_SIZE) continue;
        cluster.add(k);
        visited.add(k);
        // Find other keys sharing any token with k
        const kLabel = (graph.nodes[k]?.label || k).toLowerCase();
        const kTokens = kLabel.replace(/[\(（\)）\[\]]/g, ' ').split(/[\s\-_\.・、。,]+/).filter(t => t.length >= 2);
        const kCjk = kLabel.match(/[\u3000-\u9fff\uff00-\uffef]{3,}/g);
        if (kCjk) kTokens.push(...kCjk);
        for (const t of kTokens) {
          const related = tokenToKeys.get(t);
          if (related) for (const r of related) {
            if (!visited.has(r) && cluster.size < BATCH_SIZE) queue.push(r);
          }
        }
      }
      if (cluster.size >= 2) clusters.push([...cluster]);
    }

    // Also add remaining ungrouped keys — ALL keywords must be LLM-reviewed
    const ungrouped = currentKeys.filter(k => !visited.has(k));
    if (ungrouped.length > 0) {
      for (let i = 0; i < ungrouped.length; i += BATCH_SIZE) {
        const batch = ungrouped.slice(i, i + BATCH_SIZE);
        if (batch.length >= 1) clusters.push(batch);
      }
    }

    if (clusters.length === 0) break;

    const mergedBefore = totalMerged + totalRemoved;
    if (onLog) onLog('info', `Prune round ${round}/${MAX_ROUNDS}: ${clusters.length} groups, ${currentKeys.length} keywords remaining`);

    for (const cluster of clusters) {
      // Build keyword list for this cluster
      const sortedKeywords = cluster
        .map(k => {
          const n = graph.nodes[k];
          if (!n) return null;
          const conn = edgeCounts[k] || 0;
          return `- ${n.label} [${n.category || '未分類'}] (調査${n.count || 1}回, 接続${conn}): ${(n.description || '').slice(0, 60)}`;
        })
        .filter(Boolean)
        .join('\n');

      if (!sortedKeywords) continue;

      const prompt = fillPrompt('prune-graph.user', { sortedKeywords, goalPrompt: goalPrompt || 'なし' });
      try {
        const { parsed } = await client.queryForJson(prompt, 'JSONのみ出力してください。', queryOpts);
        if (parsed) {
          applyPruneResult(parsed);
        }
      } catch (e) {
        if (onLog) onLog('debug', `Prune round ${round} batch failed: ${e.message}`);
      }
    }

    const mergedThisRound = (totalMerged + totalRemoved) - mergedBefore;
    if (onLog) onLog('info', `Prune round ${round}: merged/removed ${mergedThisRound} keywords`);

    // If this round produced no changes, stop early
    if (mergedThisRound === 0) {
      if (onLog) onLog('info', `Prune: no changes in round ${round}, stopping early`);
      break;
    }
  }

  // Deduplicate edges
  const edgeMap = new Map();
  for (const e of graph.edges) {
    const pairKey = [e.from, e.to].sort().join('|');
    if (edgeMap.has(pairKey)) {
      edgeMap.get(pairKey).weight = (edgeMap.get(pairKey).weight || 1) + (e.weight || 1);
    } else {
      edgeMap.set(pairKey, e);
    }
  }
  graph.edges = [...edgeMap.values()];

  saveGraph(graph);

  // Clean up knowledge DB entries for removed/merged keywords
  if (removedLabels.length > 0) {
    const dbCleaned = cleanupKnowledgeDb(removedLabels);
    if (onLog && dbCleaned > 0) onLog('info', `Prune: cleaned ${dbCleaned} knowledge DB entries`);
  }

  if (onLog) onLog('info', `Prune done: merged ${totalMerged}, removed ${totalRemoved} → ${Object.keys(graph.nodes).length} nodes remain`);
  return graph;
}

/**
 * Remove JSONL entries from knowledge DB whose topic matches any of the given labels.
 * Scans brain/research/ and brain/analysis/ directories.
 */
function cleanupKnowledgeDb(labels) {
  if (!labels || labels.length === 0) return 0;
  const brainDir = path.join(__dirname, '..', 'brain');
  const dirs = [path.join(brainDir, 'research'), path.join(brainDir, 'analysis')];
  const lowerLabels = labels.map(l => l.toLowerCase().trim());
  let removed = 0;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
      const kept = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const topic = (entry.topic || '').toLowerCase().trim();
          // Remove if topic closely matches any deleted label
          const shouldRemove = lowerLabels.some(l => {
            if (!l || l.length < 2) return false;
            // Exact match or topic is a substring (both directions, but only for labels >= 4 chars)
            if (topic === l) return true;
            if (l.length >= 4 && (topic.includes(l) || l.includes(topic))) return true;
            return false;
          });
          if (shouldRemove) {
            removed++;
          } else {
            kept.push(line);
          }
        } catch {
          kept.push(line); // keep unparseable lines
        }
      }
      if (kept.length < lines.length) {
        fs.writeFileSync(filePath, kept.join('\n') + (kept.length > 0 ? '\n' : ''), 'utf-8');
      }
    }
  }
  return removed;
}

/**
 * Delete a node and its edges from the graph.
 * Also removes matching entries from the knowledge DB.
 */
function deleteNode(key) {
  const graph = loadGraph();
  if (!graph.nodes[key]) return false;
  const label = graph.nodes[key].label;
  delete graph.nodes[key];
  graph.edges = graph.edges.filter(e => e.from !== key && e.to !== key);
  saveGraph(graph);
  // Clean up knowledge DB entries for this keyword
  if (label) cleanupKnowledgeDb([label]);
  return true;
}

function normalizeKey(str) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_\u3000-\u9fff\uff00-\uffef]/g, '').slice(0, 60);
}

/**
 * Normalize a category string for comparison.
 * Handles slash-separated multi-categories by taking the first, and lowercases.
 */
function normCategory(cat) {
  if (!cat) return '';
  return cat.split('/')[0].trim().toLowerCase();
}

/**
 * Auto-connect nodes based on shared topics and same category.
 * Called after reviewGraph to ensure the graph is well-connected.
 *
 * Strategies:
 * 1. Shared topics: if two nodes were researched under the same topic, connect them
 * 2. Same category + low connectivity: connect under-linked nodes within the same category
 */
function autoConnect(onLog) {
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 2) return graph;

  // Build existing edge set for fast lookup
  const edgeSet = new Set(graph.edges.map(e => [e.from, e.to].sort().join('|')));
  let added = 0;

  function addEdge(fromKey, toKey, relation) {
    const pairKey = [fromKey, toKey].sort().join('|');
    if (edgeSet.has(pairKey)) return false;
    graph.edges.push({ from: fromKey, to: toKey, relation, weight: 1 });
    edgeSet.add(pairKey);
    added++;
    return true;
  }

  // --- Strategy 1: Shared topics ---
  // Build topic → keys index
  const topicToKeys = new Map();
  for (const k of keys) {
    const topics = graph.nodes[k].topics || [];
    for (const t of topics) {
      if (!topicToKeys.has(t)) topicToKeys.set(t, []);
      topicToKeys.get(t).push(k);
    }
  }

  for (const [topic, topicKeys] of topicToKeys) {
    if (topicKeys.length < 2 || topicKeys.length > 30) continue; // skip very large groups
    for (let i = 0; i < topicKeys.length; i++) {
      for (let j = i + 1; j < topicKeys.length; j++) {
        addEdge(topicKeys[i], topicKeys[j], `共通トピック: ${topic.slice(0, 40)}`);
      }
    }
  }

  const addedByTopic = added;

  // --- Strategy 2: Same category linkage for under-connected nodes ---
  // Count edges per node
  const edgeCounts = {};
  for (const k of keys) edgeCounts[k] = 0;
  for (const e of graph.edges) {
    if (edgeCounts[e.from] !== undefined) edgeCounts[e.from]++;
    if (edgeCounts[e.to] !== undefined) edgeCounts[e.to]++;
  }

  // Group by normalized category
  const catToKeys = new Map();
  for (const k of keys) {
    const cat = normCategory(graph.nodes[k].category);
    if (!cat) continue;
    if (!catToKeys.has(cat)) catToKeys.set(cat, []);
    catToKeys.get(cat).push(k);
  }

  for (const [cat, catKeys] of catToKeys) {
    if (catKeys.length < 2 || catKeys.length > 50) continue;
    // Only connect under-connected nodes (0-2 edges) to well-connected ones in same category
    const underConnected = catKeys.filter(k => edgeCounts[k] <= 2);
    const wellConnected = catKeys.filter(k => edgeCounts[k] >= 1)
      .sort((a, b) => (edgeCounts[b] || 0) - (edgeCounts[a] || 0));

    for (const uc of underConnected) {
      // Connect to up to 3 well-connected nodes in the same category
      let linked = 0;
      for (const wc of wellConnected) {
        if (uc === wc) continue;
        if (linked >= 3) break;
        if (addEdge(uc, wc, `同カテゴリ: ${cat}`)) linked++;
      }
    }
  }

  saveGraph(graph);
  if (onLog) onLog('info', `Auto-connect: +${addedByTopic} edges from shared topics, +${added - addedByTopic} from same category (total edges: ${graph.edges.length})`);
  return graph;
}

/**
 * Strengthen connections between keyword pairs that were searched together
 * and produced meaningful results. This reduces isolated nodes by creating
 * or strengthening edges when combined search finds related content.
 * @param {Array<{weak: string, strong: string}>} pairs - keyword pairs that were searched together
 * @param {string} topic - the research topic that found the connection
 */
function strengthenSearchPairConnections(pairs, topic) {
  if (!pairs || pairs.length === 0) return;
  const graph = loadGraph();
  let strengthened = 0;

  for (const pair of pairs) {
    // Find nodes matching the pair labels (fuzzy match)
    const weakKey = findNodeKey(graph, pair.weak);
    const strongKey = findNodeKey(graph, pair.strong);
    if (!weakKey || !strongKey || weakKey === strongKey) continue;

    const pairKey = [weakKey, strongKey].sort().join('|');
    const existing = graph.edges.find(e => {
      const ek = [e.from, e.to].sort().join('|');
      return ek === pairKey;
    });

    if (existing) {
      // Strengthen existing edge — combined search confirmed the connection
      existing.weight = (existing.weight || 1) + 2;
      existing.relation = `複合検索で確認: ${(topic || '').slice(0, 40)}`;
      strengthened++;
    } else {
      // Create new edge — combined search discovered a connection
      graph.edges.push({
        from: weakKey,
        to: strongKey,
        relation: `複合検索で発見: ${(topic || '').slice(0, 40)}`,
        weight: 2
      });
      strengthened++;
    }
  }

  if (strengthened > 0) saveGraph(graph);
  return strengthened;
}

/**
 * Find a node key by label (case-insensitive fuzzy match).
 */
function findNodeKey(graph, label) {
  if (!label) return null;
  const key = normalizeKey(label);
  if (graph.nodes[key]) return key;
  // Fuzzy: find node whose label matches
  const lower = label.toLowerCase();
  for (const [k, n] of Object.entries(graph.nodes)) {
    if ((n.label || '').toLowerCase() === lower) return k;
  }
  return null;
}

module.exports = { updateGraph, reviewGraph, pruneGraph, processUnindexedEntries, getUnderExplored, getSuggestedSearchPairs, strengthenSearchPairConnections, getGraphStats, getGraphData, deleteNode, autoConnect };
