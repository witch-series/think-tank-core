'use strict';

const fs = require('fs');
const path = require('path');
const { fillPrompt } = require('../lib/prompt-loader');

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
    const response = await client.query(prompt, 'JSONのみ出力してください。');
    const text = (response.response || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
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
async function reviewGraph(client, onLog) {
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 2) {
    if (onLog) onLog('info', `Graph review skipped: only ${keys.length} nodes`);
    return graph;
  }

  if (onLog) onLog('info', `Reviewing knowledge graph (${keys.length} nodes, ${graph.edges.length} edges)`);

  // Build node list for prompt
  const nodeList = keys.map(k => {
    const n = graph.nodes[k];
    return `- ${n.label} (${n.count || 1}回, カテゴリ: ${n.category || '未分類'}): ${(n.description || '').slice(0, 80)}`;
  }).join('\n');

  const edgeList = graph.edges.map(e => {
    const fromLabel = graph.nodes[e.from]?.label || e.from;
    const toLabel = graph.nodes[e.to]?.label || e.to;
    return `- ${fromLabel} → ${toLabel}: ${e.relation || '関連'} (重み: ${e.weight || 1})`;
  }).join('\n') || 'なし';

  const prompt = fillPrompt('review-graph.user', { nodeList, edgeList });

  try {
    const response = await client.query(prompt, 'JSONのみ出力してください。');
    const text = (response.response || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return graph;

    const result = JSON.parse(jsonMatch[0]);

    // Apply merges
    const merges = Array.isArray(result.merge) ? result.merge : [];
    for (const m of merges) {
      const fromKey = normalizeKey(m.from);
      const intoKey = normalizeKey(m.into);
      if (!fromKey || !intoKey || fromKey === intoKey) continue;
      if (!graph.nodes[fromKey] || !graph.nodes[intoKey]) continue;

      const src = graph.nodes[fromKey];
      const dst = graph.nodes[intoKey];

      // Merge counts, sources, topics
      dst.count = (dst.count || 1) + (src.count || 1);
      const srcSet = new Set([...(dst.sources || []), ...(src.sources || [])]);
      dst.sources = [...srcSet].slice(0, 20);
      const topicSet = new Set([...(dst.topics || []), ...(src.topics || [])]);
      dst.topics = [...topicSet].slice(0, 10);
      if (src.description && src.description.length > (dst.description || '').length) {
        dst.description = src.description;
      }
      dst.lastUpdated = new Date().toISOString();

      // Re-point edges from merged node
      for (const edge of graph.edges) {
        if (edge.from === fromKey) edge.from = intoKey;
        if (edge.to === fromKey) edge.to = intoKey;
      }
      // Remove self-loops
      graph.edges = graph.edges.filter(e => e.from !== e.to);

      delete graph.nodes[fromKey];
      if (onLog) onLog('debug', `Graph merge: ${m.from} → ${m.into}`);
    }

    // Apply categories
    const categories = result.categories || {};
    for (const [label, category] of Object.entries(categories)) {
      const key = normalizeKey(label);
      if (graph.nodes[key]) {
        graph.nodes[key].category = category;
      }
    }

    // Add new edges
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
      }
    }

    // Remove edges
    const removeEdges = Array.isArray(result.removeEdges) ? result.removeEdges : [];
    for (const e of removeEdges) {
      const fromKey = normalizeKey(e.from);
      const toKey = normalizeKey(e.to);
      graph.edges = graph.edges.filter(ex =>
        !((ex.from === fromKey && ex.to === toKey) || (ex.from === toKey && ex.to === fromKey))
      );
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
    if (onLog) onLog('info', `Graph review done: ${newKeys.length} nodes, ${graph.edges.length} edges (merged ${merges.length}, +${addEdges.length} edges, -${removeEdges.length} edges)`);
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
function getUnderExplored(limit = 10) {
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

  const now = Date.now();
  const scored = nodes.map(([key, node]) => {
    const age = (now - new Date(node.lastUpdated || node.firstSeen).getTime()) / (1000 * 60 * 60);
    const connections = edgeCounts[key] || 0;
    // Fewer connections + lower count + older = higher priority
    const score = (1 / (connections + 1)) * (1 / (node.count || 1)) * (1 + age / 24);
    return { key, label: node.label, description: node.description, count: node.count, connections, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Get weakly-connected keyword pairs: pick isolated nodes and suggest
 * a well-connected node to search together, so the LLM can find bridges.
 */
function getSuggestedSearchPairs(limit = 3) {
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

  // Separate weak (0-1 edges) and strong (3+ edges) nodes
  const weak = keys.filter(k => edgeCounts[k] <= 1)
    .sort((a, b) => (edgeCounts[a] || 0) - (edgeCounts[b] || 0));
  const strong = keys.filter(k => edgeCounts[k] >= 2)
    .sort((a, b) => (edgeCounts[b] || 0) - (edgeCounts[a] || 0));

  if (weak.length === 0 || strong.length === 0) return [];

  // Build connected set for quick lookup
  const connected = new Set();
  for (const e of graph.edges) connected.add(e.from + '|' + e.to);

  const pairs = [];
  for (const w of weak) {
    if (pairs.length >= limit) break;
    // Find a strong node not already connected
    const partner = strong.find(s =>
      !connected.has(w + '|' + s) && !connected.has(s + '|' + w)
    );
    if (partner) {
      pairs.push({
        weak: graph.nodes[w].label,
        strong: graph.nodes[partner].label,
        weakConnections: edgeCounts[w],
        strongConnections: edgeCounts[partner]
      });
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
function getGraphStats() {
  const graph = loadGraph();
  const nodeCount = Object.keys(graph.nodes).length;
  const edgeCount = graph.edges.length;
  if (nodeCount === 0) return { nodeCount: 0, edgeCount: 0, underExplored: '', topKeywords: '', searchSuggestions: '', score: 0, stagnant: false, scoreChange: 0, recentScores: '', categories: 0 };

  const scoreAnalysis = recordAndAnalyzeScore();

  const underExplored = getUnderExplored(5)
    .map(n => `${n.label}(調査${n.count}回/接続${n.connections})`)
    .join(', ');

  const topKeywords = Object.entries(graph.nodes)
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0))
    .slice(0, 5)
    .map(([, n]) => `${n.label}(${n.count}回)`)
    .join(', ');

  const pairs = getSuggestedSearchPairs(3);
  const searchSuggestions = pairs.length > 0
    ? pairs.map(p => `「${p.weak}」と「${p.strong}」の関連性`).join(', ')
    : '';

  return {
    nodeCount, edgeCount, underExplored, topKeywords, searchSuggestions,
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
async function pruneGraph(client, onLog) {
  const graph = loadGraph();
  const keys = Object.keys(graph.nodes);
  if (keys.length < 2) {
    if (onLog) onLog('info', `Graph prune skipped: only ${keys.length} nodes`);
    return graph;
  }

  // Pre-pass: programmatic fuzzy merge for obvious duplicates
  // Merge keys that are identical after normalization or differ only by punctuation/whitespace
  const prePassMerged = [];
  const keysByNorm = new Map();
  for (const k of keys) {
    if (!graph.nodes[k]) continue;
    // Normalize more aggressively: remove all non-alphanumeric except CJK
    const label = (graph.nodes[k].label || k).toLowerCase()
      .replace(/[\s\-_\.・、。]+/g, '')
      .replace(/[^a-z0-9\u3000-\u9fff\uff00-\uffef]/g, '');
    if (!keysByNorm.has(label)) {
      keysByNorm.set(label, []);
    }
    keysByNorm.get(label).push(k);
  }
  for (const [, group] of keysByNorm) {
    if (group.length < 2) continue;
    // Keep the one with the highest count
    group.sort((a, b) => (graph.nodes[b]?.count || 0) - (graph.nodes[a]?.count || 0));
    const keeper = group[0];
    for (let i = 1; i < group.length; i++) {
      const victim = group[i];
      if (!graph.nodes[victim] || !graph.nodes[keeper]) continue;
      const src = graph.nodes[victim];
      const dst = graph.nodes[keeper];
      dst.count = (dst.count || 1) + (src.count || 1);
      const srcSet = new Set([...(dst.sources || []), ...(src.sources || [])]);
      dst.sources = [...srcSet].slice(0, 20);
      const topicSet = new Set([...(dst.topics || []), ...(src.topics || [])]);
      dst.topics = [...topicSet].slice(0, 10);
      dst.lastUpdated = new Date().toISOString();
      for (const edge of graph.edges) {
        if (edge.from === victim) edge.from = keeper;
        if (edge.to === victim) edge.to = keeper;
      }
      graph.edges = graph.edges.filter(e => e.from !== e.to);
      prePassMerged.push(src.label || victim);
      delete graph.nodes[victim];
    }
  }
  if (prePassMerged.length > 0 && onLog) {
    onLog('info', `Pre-pass: auto-merged ${prePassMerged.length} obvious duplicates`);
  }

  // Refresh keys after pre-pass
  const currentKeys = Object.keys(graph.nodes);
  if (currentKeys.length < 2) {
    saveGraph(graph);
    return graph;
  }

  // Count edges per node for context
  const edgeCounts = {};
  for (const k of currentKeys) edgeCounts[k] = 0;
  for (const e of graph.edges) {
    if (edgeCounts[e.from] !== undefined) edgeCounts[e.from]++;
    if (edgeCounts[e.to] !== undefined) edgeCounts[e.to]++;
  }

  // Sort by label (alphabetical / 五十音順)
  const sorted = currentKeys
    .map(k => ({ key: k, label: graph.nodes[k].label || k }))
    .sort((a, b) => a.label.localeCompare(b.label, 'ja'));

  if (onLog) onLog('info', `Pruning graph: checking ${sorted.length} keywords for duplicates`);

  let totalMerged = 0;
  let totalRemoved = 0;
  const removedLabels = [...prePassMerged];

  // Send all keywords at once (no batching) so the LLM can see all duplicates
  const sortedKeywords = sorted.map(s => {
    const n = graph.nodes[s.key];
    if (!n) return null;
    const conn = edgeCounts[s.key] || 0;
    return `- ${n.label} [${n.category || '未分類'}] (調査${n.count || 1}回, 接続${conn}): ${(n.description || '').slice(0, 60)}`;
  }).filter(Boolean).join('\n');

  if (sortedKeywords) {
    const prompt = fillPrompt('prune-graph.user', { sortedKeywords });

    try {
      const response = await client.query(prompt, 'JSONのみ出力してください。');
      const text = (response.response || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);

        // Apply merges
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
          removedLabels.push(src.label || m.from);
          delete graph.nodes[fromKey];
          totalMerged++;
          if (onLog) onLog('debug', `Prune merge: ${m.from} → ${m.into}${m.reason ? ' (' + m.reason + ')' : ''}`);
        }

        // Remove junk keywords
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
    } catch (e) {
      if (onLog) onLog('debug', `Prune failed: ${e.message}`);
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
