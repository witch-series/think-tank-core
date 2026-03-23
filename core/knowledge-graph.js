'use strict';

const fs = require('fs');
const path = require('path');
const { fillPrompt } = require('../lib/prompt-loader');
const { parseJsonSafe } = require('../lib/json-parser');
const { getModelConfig } = require('../lib/model-config');

const GRAPH_PATH = path.join(__dirname, '..', 'brain', 'knowledge-graph.json');

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

  // Update nodes
  for (const kw of keywords) {
    const key = normalizeKey(kw.keyword);
    if (!key) continue;

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

  // Update edges
  for (const rel of relations) {
    const fromKey = normalizeKey(rel.from);
    const toKey = normalizeKey(rel.to);
    if (!fromKey || !toKey || fromKey === toKey) continue;
    if (!graph.nodes[fromKey] || !graph.nodes[toKey]) continue;

    const existing = graph.edges.find(e =>
      (e.from === fromKey && e.to === toKey) || (e.from === toKey && e.to === fromKey)
    );
    if (existing) {
      existing.weight = (existing.weight || 1) + 1;
      if (rel.relation) existing.relation = rel.relation;
    } else {
      graph.edges.push({
        from: fromKey,
        to: toKey,
        relation: rel.relation || '',
        weight: 1
      });
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
      graph.edges = graph.edges.filter(e => e.from !== e.to);
      delete graph.nodes[fromKey];
      if (onLog) onLog('debug', `Graph merge: ${m.from} → ${m.into}`);
      mergeCount++;
    }

    const categories = result.categories || {};
    for (const [label, category] of Object.entries(categories)) {
      const key = normalizeKey(label);
      if (graph.nodes[key]) graph.nodes[key].category = category;
    }

    const addEdges = Array.isArray(result.addEdges) ? result.addEdges : [];
    for (const e of addEdges) {
      const fromKey = normalizeKey(e.from);
      const toKey = normalizeKey(e.to);
      if (!fromKey || !toKey || fromKey === toKey) continue;
      if (!graph.nodes[fromKey] || !graph.nodes[toKey]) continue;
      const exists = graph.edges.find(ex =>
        (ex.from === fromKey && ex.to === toKey) || (ex.from === toKey && ex.to === fromKey)
      );
      if (!exists) {
        graph.edges.push({ from: fromKey, to: toKey, relation: e.relation || '', weight: 1 });
        addCount++;
      }
    }

    const removeEdges = Array.isArray(result.removeEdges) ? result.removeEdges : [];
    for (const e of removeEdges) {
      const fromKey = normalizeKey(e.from);
      const toKey = normalizeKey(e.to);
      graph.edges = graph.edges.filter(ex =>
        !((ex.from === fromKey && ex.to === toKey) || (ex.from === toKey && ex.to === fromKey))
      );
      removeCount++;
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

      const prompt = fillPrompt('review-graph.user', { nodeList, edgeList });
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

  // Separate weak (0-1 edges) and strong (2+ edges), excluding recently searched
  const weak = keys.filter(k => edgeCounts[k] <= 1 && !isRecent(k))
    .sort((a, b) => (graph.nodes[a]?.count || 0) - (graph.nodes[b]?.count || 0)); // least researched first
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
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 2) {
    if (onLog) onLog('info', `Graph prune skipped: only ${keys.length} nodes`);
    return graph;
  }

  // Pre-pass: programmatic fuzzy merge for obvious duplicates
  const prePassMerged = [];

  // Helper: merge victim into keeper
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
    graph.edges = graph.edges.filter(e => e.from !== e.to);
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

  // Helper: apply LLM prune result to graph
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
    for (const label of removes) {
      const key = normalizeKey(label);
      if (key && graph.nodes[key]) {
        removedLabels.push(graph.nodes[key].label || label);
        delete graph.nodes[key];
        graph.edges = graph.edges.filter(e => e.from !== key && e.to !== key);
        totalRemoved++;
        if (onLog) onLog('debug', `Prune remove: ${label}`);
      }
    }
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

    // Also add remaining ungrouped keys as one batch (for deletion check)
    const ungrouped = currentKeys.filter(k => !visited.has(k));
    if (ungrouped.length > 0) {
      for (let i = 0; i < ungrouped.length; i += BATCH_SIZE) {
        const batch = ungrouped.slice(i, i + BATCH_SIZE);
        if (batch.length >= 2) clusters.push(batch);
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

      const prompt = fillPrompt('prune-graph.user', { sortedKeywords });
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

module.exports = { updateGraph, reviewGraph, pruneGraph, processUnindexedEntries, getUnderExplored, getGraphStats, getGraphData, deleteNode };
