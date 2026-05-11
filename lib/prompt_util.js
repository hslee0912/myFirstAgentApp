/**
 * Prompt-building helpers shared across LLM Agents (BE / FE).
 *
 * abridgeExistingFiles(): for *initial* mode — keep .test.* and small files
 *   intact (placeholder verification basis), abridge larger files to
 *   head + tail with a [중략] marker. Reduces user-prompt input tokens
 *   substantially without losing the structural cues the LLM needs
 *   (file paths, exports near top, public API at bottom).
 *
 * abridgeForRetry(): for *retry* mode — keep only allowed_paths in full;
 *   collapse other files to a one-line stub. Retry only modifies allowed
 *   files so non-allowed file contents are dead weight in the prompt.
 *
 * Decision provenance (docs/DECISIONS.md, 2026-05-08):
 *   O1 = abridgeExistingFiles
 *   O2 = abridgeForRetry
 */
'use strict';

/**
 * Reduce existing_files map for *initial* mode prompts.
 *
 * Keeps intact:
 *   - files matching keepFullPatterns (default: *.test.js / *.test.jsx) —
 *     placeholders that the agent must satisfy verbatim.
 *   - files with <= keepFullSizeLimit lines (default: 100) — small enough
 *     that abridging would save little.
 *
 * Otherwise, replaces content with: head N + middle elision marker + tail M.
 *
 * @param {Object<string,string>} existing_files - { path: content } map
 * @param {Object} [options]
 * @param {RegExp[]} [options.keepFullPatterns]
 * @param {number}   [options.keepFullSizeLimit]
 * @param {number}   [options.headLines]
 * @param {number}   [options.tailLines]
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
 * Files in allowed_paths: kept in full (they are the modification target).
 * Other files: collapsed to a one-line stub revealing only path + line count.
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

module.exports = { abridgeExistingFiles, abridgeForRetry };
