'use strict';

const { queryOllama } = require('./crawler');

async function verify(ollamaUrl, model, originalInsights, sourceText) {
  const prompt = `あなたは批判的検証者です。以下の抽出結果を検証してください。

元テキスト:
${sourceText}

抽出結果:
${JSON.stringify(originalInsights, null, 2)}

以下を確認してください:
1. 各項目が元テキストに根拠があるか
2. 論理的矛盾がないか
3. 過度な一般化や飛躍がないか

以下のJSON形式で返答してください:
{
  "verified": true/false,
  "confidence": 0.0-1.0,
  "issues": ["問題点1", "問題点2"],
  "approved": { /* 検証済みの項目のみ */ },
  "rejected": ["棄却理由1"]
}`;

  const response = await queryOllama(ollamaUrl, model, prompt, 'あなたは批判的思考の専門家です。提示された情報の正確性を厳密に検証してください。');

  try {
    const jsonMatch = response.response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch {}

  return {
    verified: false,
    confidence: 0,
    issues: ['Failed to parse verification response'],
    approved: null,
    rejected: ['Verification parse failure']
  };
}

async function doubleCheck(ollamaUrl, model, sourceText) {
  const { extractInsights } = require('./crawler');

  const insights = await extractInsights(ollamaUrl, model, sourceText);
  const verification = await verify(ollamaUrl, model, insights, sourceText);

  return {
    insights,
    verification,
    accepted: verification.verified && verification.confidence >= 0.7,
    timestamp: new Date().toISOString()
  };
}

module.exports = { verify, doubleCheck };
