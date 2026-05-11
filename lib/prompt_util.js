/**
 * Prompt-building helpers shared across LLM Agents (BE / FE).
 *
 * abridgeExistingFiles(): for *initial* mode — keep .test.* and small files
 *   intact (placeholder verification basis), abridge larger files to
 *   head + tail with a [중략] marker.
 *
 * abridgeForRetry(): for *retry* mode — keep only allowed_paths in full;
 *   collapse other files to a one-line stub.
 *
 * dropProtectedFiles(): defense-in-depth filter — removes protected-file
 *   entries from an LLM response BEFORE validatePaths runs. Guards against
 *   the LLM occasionally ignoring the system-prompt instruction. Returns
 *   the filtered map + the list of dropped paths so callers can surface the
 *   drop in their output_json audit trail.
 *
 * validateAllowedDeps(): scans LLM response files for require()/import
 *   statements and verifies every non-relative, non-builtin module is in the
 *   stack's allowedDeps list. Throws on first violation. Used right after
 *   dropProtectedFiles to fail fast when the LLM introduces unauthorized deps
 *   like 'email-validator' that would later blow up at Jest/Vitest stage 3.
 *
 * Decision provenance (docs/DECISIONS.md, 2026-05-08):
 *   O1 = abridgeExistingFiles
 *   O2 = abridgeForRetry
 *   Y  = dropProtectedFiles (silent drop instead of validatePaths throw)
 */
'use strict';

const { isBuiltin } = require('module');

/**
 * Reduce existing_files map for *initial* mode prompts.
 *
 * Keeps intact:
 *   - files matching keepFullPatterns (default: *.test.js / *.test.jsx)
 *   - files with <= keepFullSizeLimit lines (default: 100)
 *
 * Otherwise replaces content with: head N + middle elision marker + tail M.
 *
 * @param {Object<string,string>} existing_files
 * @param {Object} [options]
 * @returns {Object<string,string>}
 */
function abridgeExistingFiles(existing_files, options = {}) {
  const {
    keepFullPatterns = [/\.test\.(js|jsx)$/],
    keepFullSizeLimit = 100,
    headLines = 40,
    tailLines = 15,
  } = options;

  const out = {};
  for (const [path, content] of Object.entries(existing_files || {})) {
    const lines = (content || '').split('\n');
    const keepFull =
      keepFullPatterns.some((p) => p.test(path)) || lines.length <= keepFullSizeLimit;
    if (keepFull) {
      out[path] = content;
      continue;
    }
    out[path] = [
      ...lines.slice(0, headLines),
      `// ─── [중략: 총 ${lines.length}줄 중 ${lines.length - headLines - tailLines}줄 생략] ───`,
      ...lines.slice(-tailLines),
    ].join('\n');
  }
  return out;
}

/**
 * Reduce existing_files map for *retry* mode prompts.
 *
 * @param {Object<string,string>} existing_files
 * @param {string[]} allowed_paths
 * @returns {Object<string,string>}
 */
function abridgeForRetry(existing_files, allowed_paths) {
  const allowedSet = new Set(allowed_paths || []);
  const out = {};
  for (const [path, content] of Object.entries(existing_files || {})) {
    if (allowedSet.has(path)) {
      out[path] = content;
    } else {
      const lines = (content || '').split('\n');
      out[path] = `// <unchanged file, ${lines.length} lines, not in allowed_paths>`;
    }
  }
  return out;
}

/**
 * Defense-in-depth: silently remove protected-file entries from the LLM
 * response BEFORE validatePaths runs. Guards against the LLM occasionally
 * ignoring the system-prompt instruction not to modify lint/docker/package
 * configs.
 *
 * Logs a warning per dropped file so the silent drop is visible. Returns
 * { files, dropped } so the agent can record which files were dropped in
 * its output_json audit trail.
 *
 * @param {Object<string,string>} files - LLM response files map
 * @param {string[]} protectedList - paths that must never be modified
 * @param {string} [agentLabel] - label used in the warn log
 * @returns {{ files: Object<string,string>, dropped: string[] }}
 */
function dropProtectedFiles(files, protectedList, agentLabel = 'Agent') {
  const protectedSet = new Set(protectedList || []);
  const out = {};
  const dropped = [];
  for (const [path, content] of Object.entries(files || {})) {
    if (protectedSet.has(path)) {
      dropped.push(path);
      console.warn(`[${agentLabel}] dropped protected file from response: ${path}`);
    } else {
      out[path] = content;
    }
  }
  return { files: out, dropped };
}

/**
 * Verify every require()/import in LLM-generated files refers to either:
 *   - a relative/absolute path (./, ../, /)
 *   - a Node.js built-in module (fs, path, crypto, …)
 *   - a top-level name in `allowedDeps`
 *
 * Throws with code='UNAUTHORIZED_DEPS' on first violation set, listing every
 * offending file/module so the agent's endRun records the full set for the
 * developer. Called right after dropProtectedFiles, before validatePaths.
 *
 * @param {Object<string,string>} files
 * @param {string|string[]} allowedDeps - csv string ("express, mysql2") or array
 * @param {string} [agentLabel]
 * @returns {{ violations: Array<{path: string, module: string}> }} empty when OK
 */
function validateAllowedDeps(files, allowedDeps, agentLabel = 'Agent') {
  const csv = typeof allowedDeps === 'string'
    ? allowedDeps.split(',').map((s) => s.trim()).filter(Boolean)
    : (allowedDeps || []);
  const allowed = new Set(csv);

  const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const importRe = /import\s+(?:[^'";]*?from\s+)?['"]([^'"]+)['"]/g;

  const violations = [];
  for (const [filePath, content] of Object.entries(files || {})) {
    if (!/\.(js|jsx)$/.test(filePath)) continue;
    const seen = new Set();
    let m;
    requireRe.lastIndex = 0;
    while ((m = requireRe.exec(content || '')) !== null) seen.add(m[1]);
    importRe.lastIndex = 0;
    while ((m = importRe.exec(content || '')) !== null) seen.add(m[1]);

    for (const mod of seen) {
      if (mod.startsWith('.') || mod.startsWith('/')) continue;
      const bare = mod.replace(/^node:/, '');
      const topLevel = bare.startsWith('@')
        ? bare.split('/').slice(0, 2).join('/')
        : bare.split('/')[0];
      if (isBuiltin(bare) || isBuiltin(topLevel)) continue;
      if (allowed.has(topLevel)) continue;
      violations.push({ path: filePath, module: topLevel });
    }
  }

  if (violations.length > 0) {
    const list = violations.map((v) => `${v.path}: '${v.module}'`).join('; ');
    const err = new Error(
      `[${agentLabel}] Unauthorized dependencies detected: ${list}. ` +
      `Allowed: ${[...allowed].join(', ')}. ` +
      `Replace these imports with logic using allowed deps, or request the dep in 'notes' — ` +
      `do NOT modify package.json (protected).`
    );
    err.code = 'UNAUTHORIZED_DEPS';
    err.violations = violations;
    throw err;
  }

  return { violations };
}

module.exports = { abridgeExistingFiles, abridgeForRetry, dropProtectedFiles, validateAllowedDeps };
