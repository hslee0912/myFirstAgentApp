/**
 * Read / atomically rewrite key=value pairs in a .env file.
 *
 * The UI is "GUI editor for .env" — every toggle change goes through here.
 * Atomic write pattern: write a temp file in the same directory, then rename.
 * `fs.renameSync` is atomic on both POSIX and Windows when source and target
 * live on the same filesystem (which is the case here — both are in the
 * project root).
 *
 * Comments + blank lines + non-touched keys are preserved verbatim. Only the
 * value of the matched key is updated. If the key does not exist, it is
 * appended at the end with a blank line before it.
 *
 * Why we don't use `dotenv` to round-trip: dotenv only parses, it doesn't
 * serialize back, and it discards comments/order. The UI must preserve the
 * file as the user sees it.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse a .env file into a plain object of { key: value }. Comments and blank
 * lines are ignored. Lines that don't match `KEY=VALUE` are skipped. Quoted
 * values are unwrapped.
 *
 * @param {string} envPath
 * @returns {Object<string,string>}
 */
function readEnv(envPath) {
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1);
    // Strip a single layer of surrounding quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Update one or more keys in a .env file. Preserves comments, blank lines,
 * unrelated keys, and line ordering. Missing keys are appended at the end.
 *
 * Atomic: writes to `<envPath>.tmp` first, then renames over the original.
 *
 * @param {string} envPath
 * @param {Object<string,string|number|boolean>} updates - keys to set
 * @returns {{ updated: string[], appended: string[] }}
 */
function updateEnv(envPath, updates) {
  const updated = [];
  const appended = [];
  const pending = new Map(
    Object.entries(updates || {}).map(([k, v]) => [k, String(v)])
  );

  const existing = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, 'utf8')
    : '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = existing.split(/\r?\n/);

  const outLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return line;
    const eq = line.indexOf('=');
    if (eq <= 0) return line;
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const newValue = pending.get(key);
    pending.delete(key);
    updated.push(key);
    return `${key}=${newValue}`;
  });

  if (pending.size > 0) {
    // Trim trailing empty lines so we append cleanly.
    while (outLines.length > 0 && outLines[outLines.length - 1] === '') {
      outLines.pop();
    }
    if (outLines.length > 0) outLines.push('');
    for (const [key, value] of pending) {
      outLines.push(`${key}=${value}`);
      appended.push(key);
    }
  }

  // Ensure exactly one trailing newline. `outLines.join(eol)` already produces
  // a trailing newline whenever the array ends with '' (which happens when the
  // original file ended with a newline — the split leaves a trailing empty
  // element). Adding another eol would double it.
  let next = outLines.join(eol);
  if (!next.endsWith(eol)) next += eol;
  const tmpPath = `${envPath}.tmp`;
  fs.writeFileSync(tmpPath, next, 'utf8');
  fs.renameSync(tmpPath, envPath);

  return { updated, appended };
}

/**
 * Two groups of editable env keys:
 *
 *   - TOGGLE_KEYS    — always visible inline as on/off toggles (primary controls).
 *   - ADVANCED_KEYS  — surfaced only via the UI's "⚙ Advanced env" popup
 *                      (models, ports, timeouts, retries). Same write path,
 *                      same allowlist enforcement — purely a layout decision.
 *
 * `UI_EDITABLE_KEYS` (the server-side allowlist) is the union of the two.
 * Anything outside this allowlist is rejected by the UI server so a wayward
 * PUT can't blank out `ANTHROPIC_API_KEY` or `DB_PASSWORD`.
 */
const TOGGLE_KEYS = Object.freeze([
  'COMMIT_MODE',
  'VALIDATION_MODE',
  'DEPLOY_MODE',
  'DEPLOY_TEARDOWN_ON_PASS',
]);

const ADVANCED_KEYS = Object.freeze([
  // Models
  'ANTHROPIC_MODEL',
  'CODECHECKER_MODEL',
  'BE_AGENT_MODEL',
  'FE_AGENT_MODEL',
  // Orchestrator
  'MAX_RETRIES',
  'LLM_INTER_CALL_MS',
  'LLM_INTER_ROUND_MS',
  // Deploy
  'DEPLOY_PORT_FE',
  'DEPLOY_PORT_BE',
  'DEPLOY_PORT_DB',
  'DEPLOY_TIMEOUT_SEC',
  'POSTTEST_TIMEOUT_SEC',
  'LOG_TAIL_LINES',
  // Browser-facing host for FE/BE links. Defaults to "localhost"; set to the
  // EC2 public DNS/IP when deploying remotely. Server-side DB_HOST is separate.
  'PUBLIC_HOST',
]);

const UI_EDITABLE_KEYS = Object.freeze([...TOGGLE_KEYS, ...ADVANCED_KEYS]);

module.exports = { readEnv, updateEnv, UI_EDITABLE_KEYS, TOGGLE_KEYS, ADVANCED_KEYS };
