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
 * Decision provenance (docs/DECISIONS.md, 2026-05-08):
 *   O1 = abridgeExistingFiles
 *   O2 = abridgeForRetry
 *   Y  = dropProtectedFiles (silent drop instead of validatePaths throw)
 */
'use strict';

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

module.exports = { abridgeExistingFiles, abridgeForRetry, dropProtectedFiles };
