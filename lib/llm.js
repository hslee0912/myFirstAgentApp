/**
 * Thin wrapper around @anthropic-ai/sdk.
 *
 * Used by CodeChecker / FE / BE Agents. Lint Agent and Orchestrator do NOT use this.
 *
 * Always asks for JSON output and returns parsed object.
 *
 * Diagnostics:
 *   - assertContextBudget(...) verifies prompt fits in the model's context window
 *     BEFORE the API call. Each Agent calls it explicitly; callJSON also re-runs
 *     the same check internally as defense in depth.
 *   - callJSON inspects response.stop_reason and response.usage AFTER the call.
 *     If stop_reason='max_tokens' the response was truncated and JSON parsing
 *     will almost certainly fail; the truncation is loudly logged and surfaced
 *     as part of the final error message.
 *   - On parse failure the thrown Error carries a diagnostic block with
 *     stop_reason, token usage, and raw response head/tail (300 chars each).
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

const AGENT_ENV_KEY = {
  codechecker: 'CODECHECKER_MODEL',
  be: 'BE_AGENT_MODEL',
  fe: 'FE_AGENT_MODEL',
};

// Default per-call output cap. Generous enough that multi-file responses don't
// hit the cap on the happy path. Each Agent can override per call via opts.max_tokens.
const DEFAULT_MAX_TOKENS = 8192;

// Rough char/token ratios used by estimateTokens():
//   - English plain text: ~4 chars/token
//   - Korean (UTF-8 hangul): ~2 chars/token
//   - JS/JSX code: ~3.5 chars/token
// Mixed Korean docs + JSX code → use 3 as a safe (over-estimating) default.
const CHARS_PER_TOKEN = 3;

// Per-model context limits. Conservative; actual model docs may report higher.
//   input: total context window (input + output share this budget for chat models)
//   max_output: per-call output cap
const MODEL_LIMITS = {
  'claude-haiku-4-5':  { input: 200_000, max_output: 64_000 },
  'claude-sonnet-4-5': { input: 200_000, max_output: 64_000 },
  'claude-opus-4-5':   { input: 200_000, max_output: 64_000 },
  'default':           { input: 200_000, max_output: 64_000 },
};

function getModelLimits(model) {
  return MODEL_LIMITS[model] || MODEL_LIMITS.default;
}

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

/**
 * Rough token estimate from char count. Not exact — real tokenization happens
 * server-side. Useful for client-side budget checks before sending to the API.
 *
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Verify the planned API call fits in the model's context window.
 *
 * - HARD FAIL (throws) when input + max_output exceeds the model's input limit
 *   or when max_output exceeds the model's per-call output cap.
 * - SOFT WARN (console) at >= 80% utilization — the call still proceeds.
 * - On the happy path logs a one-line context summary so every LLM call leaves
 *   an audit trail of how much budget it used.
 *
 * Agents call this explicitly right before invoking callJSON; callJSON also
 * re-runs the same check internally as a defensive safety net.
 *
 * @param {Object} args
 * @param {string} args.system
 * @param {string} args.user
 * @param {number} [args.max_tokens] - planned output budget (default DEFAULT_MAX_TOKENS)
 * @param {string} [args.model]      - explicit model id (else resolved from agent)
 * @param {'codechecker'|'be'|'fe'} [args.agent]
 * @returns {{ inputTokens: number, maxOutput: number, modelLimit: number, utilization: number }}
 */
function assertContextBudget({ system, user, max_tokens, model, agent }) {
  const resolvedModel = model || resolveModel(agent);
  const limits = getModelLimits(resolvedModel);

  const sysT = estimateTokens(typeof system === 'string' ? system : JSON.stringify(system || ''));
  const userT = estimateTokens(typeof user === 'string' ? user : JSON.stringify(user || ''));
  const inputTokens = sysT + userT;
  const maxOutput = max_tokens || DEFAULT_MAX_TOKENS;

  const total = inputTokens + maxOutput;
  const utilization = total / limits.input;

  if (total > limits.input) {
    throw new Error(
      `[llm:${agent || '?'}] Context budget exceeded: ` +
      `input ~${inputTokens}t + max_output ${maxOutput}t = ${total}t > model input window ${limits.input}t ` +
      `(model=${resolvedModel}). Reduce prompt size or max_tokens.`
    );
  }
  if (maxOutput > limits.max_output) {
    throw new Error(
      `[llm:${agent || '?'}] max_tokens=${maxOutput} exceeds model max output ${limits.max_output} ` +
      `(model=${resolvedModel}).`
    );
  }
  if (utilization >= 0.8) {
    console.warn(
      `[llm:${agent || '?'}] WARN context utilization ${(utilization * 100).toFixed(1)}% ` +
      `(input ~${inputTokens}t + max_output ${maxOutput}t of ${limits.input}t, model=${resolvedModel})`
    );
  } else {
    console.log(
      `[llm:${agent || '?'}] context budget OK: input ~${inputTokens}t ` +
      `(sys ${sysT}t + user ${userT}t), max_output ${maxOutput}t, model=${resolvedModel}, ` +
      `utilization ${(utilization * 100).toFixed(1)}%`
    );
  }

  return { inputTokens, maxOutput, modelLimit: limits.input, utilization };
}

/**
 * Send a message and return parsed JSON.
 *
 * On parse failure, retries the LLM call up to MAX_LLM_RETRIES times with a
 * stricter prompt. The final error includes a diagnostic block with stop_reason,
 * output token count, truncation flag, and raw response head/tail (300 chars each).
 *
 * @param {Object} opts
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {'codechecker'|'be'|'fe'} [opts.agent]
 * @param {string} [opts.model]
 * @param {number} [opts.max_tokens]
 * @param {'system'|'user'} [opts.cache]
 * @param {number} [opts._retry] - internal retry counter, do not pass externally
 * @returns {Promise<Object>}
 */
async function callJSON({ system, user, agent, model, max_tokens = DEFAULT_MAX_TOKENS, cache, _retry = 0 }) {
  const MAX_LLM_RETRIES = 2;
  const resolvedModel = model || resolveModel(agent);

  // Pre-call defensive budget check (Agents call this too; this is defense in depth).
  assertContextBudget({ system, user, max_tokens, model: resolvedModel, agent });

  const baseHint =
    '\n\n반드시 유효한 JSON 객체 하나만 응답하라. 마크다운 코드블록 금지. 설명 텍스트 금지.';
  const retryHint =
    `\n\n[RETRY ${_retry}/${MAX_LLM_RETRIES}] 이전 응답이 JSON 파싱에 실패했다. ` +
    '모든 string value 안의 escape에 신중히: ' +
    '큰따옴표는 \\", 백슬래시는 \\\\, 줄바꿈은 \\n, 탭은 \\t. ' +
    '코드를 string으로 넣을 때 따옴표/백슬래시가 빠지면 string이 일찍 종료되어 다음 토큰이 syntax error가 된다. ' +
    '응답 직전 모든 string value를 스스로 검증한 뒤 출력하라.';
  const lastUser = user + baseHint + (_retry > 0 ? retryHint : '');

  const systemParam = cache === 'system'
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : system;

  const messages = cache === 'user'
    ? [{
        role: 'user',
        content: [
          { type: 'text', text: lastUser, cache_control: { type: 'ephemeral' } },
        ],
      }]
    : [{ role: 'user', content: lastUser }];

  const response = await client.messages.create({
    model: resolvedModel,
    max_tokens,
    system: systemParam,
    messages,
  });

  // Surface usage + cache stats so every call leaves an audit line.
  const u = response.usage || {};
  if (u.cache_creation_input_tokens) {
    console.log(`[llm:${agent || '?'}] cache write: ${u.cache_creation_input_tokens} tokens`);
  }
  if (u.cache_read_input_tokens) {
    console.log(`[llm:${agent || '?'}] cache hit: ${u.cache_read_input_tokens} tokens (~90% saved)`);
  }
  console.log(
    `[llm:${agent || '?'}] usage: input=${u.input_tokens || 0}t output=${u.output_tokens || 0}t, ` +
    `stop_reason=${response.stop_reason}`
  );

  // Post-call truncation detection. stop_reason='max_tokens' is the canonical
  // signal that the response was cut off at the cap → JSON will be invalid.
  const truncated = response.stop_reason === 'max_tokens';
  const outputBudgetUsed = (u.output_tokens || 0) / max_tokens;
  if (truncated) {
    console.error(
      `[llm:${agent || '?'}] ❌ TRUNCATED — stop_reason=max_tokens. ` +
      `output_tokens=${u.output_tokens} reached cap=${max_tokens}. ` +
      `Response is incomplete; will not attempt JSON parse.`
    );
    // S2: truncation routes immediately to retry / throw — no parseJSONLoose
    // attempt (it would fail anyway on the cut-off JSON, wasting the dump
    // file and obscuring the real cause).
    if (_retry < MAX_LLM_RETRIES) {
      console.warn(
        `[llm:${agent || '?'}] truncated, retrying with stricter prompt ` +
        `(${_retry + 1}/${MAX_LLM_RETRIES + 1})...`
      );
      return callJSON({
        system, user, agent, model, max_tokens, cache, _retry: _retry + 1,
      });
    }
    const truncErr = new Error(
      `LLM response TRUNCATED after ${MAX_LLM_RETRIES + 1} attempts. ` +
      `output_tokens=${u.output_tokens || 0} hit cap=${max_tokens} (model=${resolvedModel}). ` +
      `Increase max_tokens or shorten input.`
    );
    truncErr.code = 'LLM_TRUNCATED';
    throw truncErr;
  } else if (outputBudgetUsed >= 0.9) {
    console.warn(
      `[llm:${agent || '?'}] WARN output near cap: ` +
      `${u.output_tokens}/${max_tokens} (${(outputBudgetUsed * 100).toFixed(1)}%). ` +
      `Consider increasing max_tokens.`
    );
  }

  const text = (response.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  try {
    return parseJSONLoose(text);
  } catch (parseErr) {
    // Build rich diagnostic for both retry log and final throw.
    const tail = text.slice(Math.max(0, text.length - 300));
    const head = text.slice(0, 300);
    const diagnostic =
      `\n  ─ stop_reason: ${response.stop_reason}` +
      `\n  ─ output_tokens: ${u.output_tokens || 0} / max_tokens: ${max_tokens}` +
      (truncated
        ? '\n  ─ ⚠️ RESPONSE WAS TRUNCATED (stop_reason=max_tokens). Increase max_tokens, shorten input, or split the request.'
        : '\n  ─ stop_reason is end_turn — not a truncation issue. Likely a string-escape or JSON-syntax issue inside the response body.') +
      `\n  ─ raw text length: ${text.length} chars (~${estimateTokens(text)} tokens)` +
      `\n  ─ raw text HEAD (first 300 chars): ${head.replace(/\n/g, '\\n')}` +
      `\n  ─ raw text TAIL (last 300 chars):  ${tail.replace(/\n/g, '\\n')}`;

    if (_retry < MAX_LLM_RETRIES) {
      console.warn(
        `[llm:${agent || '?'}] JSON parse failed (attempt ${_retry + 1}/${MAX_LLM_RETRIES + 1}):` +
        `${diagnostic}\n  ─ retrying with stricter prompt...`
      );
      return callJSON({
        system, user, agent, model, max_tokens, cache, _retry: _retry + 1,
      });
    }

    // Final failure: re-throw with diagnostic appended to message.
    parseErr.message = parseErr.message + '\n\n[diagnostic]' + diagnostic;
    throw parseErr;
  }
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

  try { return JSON.parse(text); }
  catch (e) { attempts.push({ stage: 'raw', err: e.message }); }

  const stripped = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try { return JSON.parse(stripped); }
  catch (e) { attempts.push({ stage: 'fence-strip', err: e.message }); }

  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  let sliced = stripped;
  if (start !== -1 && end !== -1 && end > start) {
    sliced = stripped.slice(start, end + 1);
    try { return JSON.parse(sliced); }
    catch (e) { attempts.push({ stage: 'slice', err: e.message }); }
  }

  try {
    const repaired = jsonrepair(sliced);
    return JSON.parse(repaired);
  } catch (e) {
    attempts.push({ stage: 'jsonrepair', err: e.message });
  }

  // All failed — dump raw response so it can be inspected.
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
    `LLM did not return valid JSON after ${attempts.length} recovery attempts. ` +
    `Raw response dumped to: ${dumpPath}\n` +
    `Last error: ${attempts[attempts.length - 1].err}\n` +
    `First 300 chars: ${text.slice(0, 300)}`
  );
}

module.exports = {
  callJSON,
  resolveModel,
  estimateTokens,
  assertContextBudget,
  MODEL_LIMITS,
  DEFAULT_MAX_TOKENS,
};
