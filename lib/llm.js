/**
 * Thin wrapper around @anthropic-ai/sdk.
 *
 * Used by CodeChecker / FE / BE Agents. Lint Agent and Orchestrator do NOT use this.
 *
 * Always asks for JSON output and returns parsed object.
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { jsonrepair } = require('jsonrepair');
// override:true → .env 값이 시스템 env(특히 비어있는 ANTHROPIC_API_KEY)에 덮어쓰기됨
require('dotenv').config({ override: true });

const client = new Anthropic.default({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const FALLBACK_MODEL = 'claude-sonnet-4-5';

// Per-agent env var keys. Each agent can have its own model; falls back to
// ANTHROPIC_MODEL, then the hardcoded fallback.
const AGENT_ENV_KEY = {
  codechecker: 'CODECHECKER_MODEL',
  be: 'BE_AGENT_MODEL',
  fe: 'FE_AGENT_MODEL',
};

/**
 * Resolve the model for a given agent, using:
 *   1. <AGENT>_MODEL env var (e.g. BE_AGENT_MODEL)
 *   2. ANTHROPIC_MODEL env var (global default)
 *   3. FALLBACK_MODEL (hardcoded last resort)
 *
 * @param {'codechecker'|'be'|'fe'} [agent]
 * @returns {string}
 */
function resolveModel(agent) {
  if (agent && AGENT_ENV_KEY[agent]) {
    const v = process.env[AGENT_ENV_KEY[agent]];
    if (v && v.trim()) return v.trim();
  }
  if (process.env.ANTHROPIC_MODEL && process.env.ANTHROPIC_MODEL.trim()) {
    return process.env.ANTHROPIC_MODEL.trim();
  }
  return FALLBACK_MODEL;
}

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
 * @param {'codechecker'|'be'|'fe'} [opts.agent] - identity for per-agent model resolution
 * @param {string} [opts.model] - explicit model override (wins over agent-based resolution)
 * @param {number} [opts.max_tokens]
 * @returns {Promise<Object>}
 */
async function callJSON({ system, user, agent, model, max_tokens = DEFAULT_MAX_TOKENS }) {
  const resolvedModel = model || resolveModel(agent);
  const lastUser =
    user +
    '\n\n반드시 유효한 JSON 객체 하나만 응답하라. 마크다운 코드블록 금지. 설명 텍스트 금지.';

  const response = await client.messages.create({
    model: resolvedModel,
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
 * Try to parse JSON, falling back through several recovery strategies:
 *   1. JSON.parse(text) — happy path
 *   2. Strip ```json fences → JSON.parse
 *   3. Slice from first '{' to last '}' → JSON.parse
 *   4. jsonrepair (handles trailing commas, missing commas, unescaped chars common in
 *      LLM-emitted code-as-string responses) → JSON.parse
 *   5. All failed → dump raw response to /tmp for debugging, throw with context
 */
function parseJSONLoose(text) {
  const attempts = [];

  // 1. raw
  try { return JSON.parse(text); }
  catch (e) { attempts.push({ stage: 'raw', err: e.message }); }

  // 2. strip code fences
  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try { return JSON.parse(stripped); }
  catch (e) { attempts.push({ stage: 'fence-strip', err: e.message }); }

  // 3. slice from first { to last }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let sliced = stripped;
  if (start !== -1 && end !== -1 && end > start) {
    sliced = stripped.slice(start, end + 1);
    try { return JSON.parse(sliced); }
    catch (e) { attempts.push({ stage: 'slice', err: e.message }); }
  }

  // 4. jsonrepair — repairs common LLM JSON malformations (escapes, trailing commas, etc.)
  try {
    const repaired = jsonrepair(sliced);
    return JSON.parse(repaired);
  } catch (e) {
    attempts.push({ stage: 'jsonrepair', err: e.message });
  }

  // 5. all failed — dump raw response so it can be inspected.
  const dumpDir = process.env.LLM_DEBUG_DIR || require('os').tmpdir();
  try { fs.mkdirSync(dumpDir, { recursive: true }); } catch (_) {}
  const dumpPath = path.join(
    dumpDir,
    `llm-bad-response-${Date.now()}-${process.pid}.txt`
  );
  try {
    fs.writeFileSync(
      dumpPath,
      `--- attempts ---\n${attempts.map((a) => `[${a.stage}] ${a.err}`).join('\n')}\n\n--- raw text (${text.length} chars) ---\n${text}`,
      'utf8'
    );
  } catch (_) { /* best-effort */ }

  throw new Error(
    `LLM did not return valid JSON after 4 recovery attempts. ` +
    `Raw response dumped to: ${dumpPath}\n` +
    `Last error: ${attempts[attempts.length - 1].err}\n` +
    `First 300 chars: ${text.slice(0, 300)}`
  );
}

module.exports = { callJSON, resolveModel };
