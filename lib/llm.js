/**
 * Thin wrapper around @anthropic-ai/sdk.
 *
 * Used by CodeChecker / FE / BE Agents. Lint Agent and Orchestrator do NOT use this.
 *
 * Always asks for JSON output and returns parsed object.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
// override:true → .env 값이 시스템 env(특히 비어있는 ANTHROPIC_API_KEY)에 덮어쓰기됨
require('dotenv').config({ override: true });

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
// Rate limit (30k input tokens/minute) is mitigated by inter-call sleeps in orchestrator,
// NOT by max_tokens (which only caps output). Keep max_tokens generous so multi-file responses
// don't get truncated mid-JSON.
const DEFAULT_MAX_TOKENS = 8192;

/**
 * Send a message and return parsed JSON.
 * Will retry once if the response isn't valid JSON.
 *
 * @param {Object} opts
 * @param {string} opts.system - system prompt
 * @param {string} opts.user   - user message
 * @param {string} [opts.model]
 * @param {number} [opts.max_tokens]
 * @returns {Promise<Object>}
 */
async function callJSON({ system, user, model = DEFAULT_MODEL, max_tokens = DEFAULT_MAX_TOKENS }) {
  const lastUser =
    user +
    '\n\n반드시 유효한 JSON 객체 하나만 응답하라. 마크다운 코드블록 금지. 설명 텍스트 금지.';

  const response = await client.messages.create({
    model,
    max_tokens,
    system,
    messages: [{ role: 'user', content: lastUser }],
  });

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  return parseJSONLoose(text);
}

/**
 * Try to parse JSON, falling back to extracting the first {...} block if there's stray text.
 */
function parseJSONLoose(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    // strip code fences if any
    const stripped = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    try {
      return JSON.parse(stripped);
    } catch (_e2) {
      const start = stripped.indexOf('{');
      const end = stripped.lastIndexOf('}');
      if (start !== -1 && end !== -1 && end > start) {
        const sliced = stripped.slice(start, end + 1);
        return JSON.parse(sliced);
      }
      throw new Error(`LLM did not return valid JSON. Got:\n${text.slice(0, 500)}`);
    }
  }
}

module.exports = { callJSON };
