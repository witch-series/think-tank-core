/**
 * AIとロボットの技術動向に関するモジュール
 * 研究結果に基づき、AIとロボットの関連技術トレンドを把握するための機能を提供する。
 */

'use strict';

/**
 * 研究結果オブジェクトの解析を行う関数
 * @param {object} researchData 研究結果オブジェクト
 * @returns {string[]} 解析結果の配列
 */
function parseResearchData(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    throw new Error('Invalid researchData input.  Must be an object.');
  }

  const insights = researchData.insights || [];
  const result = [];

  for (const insight of insights) {
    if (typeof insight === 'string') {
      result.push(insight);
    } else if (Array.isArray(insight)) {
      result.push(...insight);
    } else if (typeof insight === 'object' && insight !== null) {
       //Handle nested objects - simplified example
       result.push(JSON.stringify(insight)); //For demonstration, stringify
    }
    else {
      result.push('Invalid Insight Format');
    }
  }

  return result;
}

/**
 * 研究結果のタイムスタンプを取得する関数
 * @param {object} researchData 研究結果オブジェクト
 * @returns {string|null} タイムスタンプ文字列、またはタイムスタンプが存在しない場合は null
 */
function getTimestamp(researchData) {
  if (!researchData || typeof researchData !== 'object') {
    throw new Error('Invalid researchData input.  Must be an object.');
  }
  return researchData.timestamp;
}

/**
 * モジュールエクスポート
 * @returns {{parseResearchData: function, getTimestamp: function}}  
 */
module.exports = {
  parseResearchData: parseResearchData,
  getTimestamp: getTimestamp
};
