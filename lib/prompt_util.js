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
    // D64 (2026-05-15): hint에 위반 패키지별 *구체적* 대체 코드 표 inject —
    // round retry의 fix_instructions로 LLM이 받았을 때 정확히 무엇으로 바꿀지 인지.
    const distinctModules = [...new Set(violations.map((v) => v.module))];
    const hintLines = distinctModules
      .map((mod) => REPLACEMENT_HINTS[mod] ? `  - ${mod}: ${REPLACEMENT_HINTS[mod]}` : `  - ${mod}: (allowedDeps에 없음. notes에 사유만 기록.)`)
      .join('\n');
    const err = new Error(
      `[${agentLabel}] Unauthorized dependencies detected: ${list}.\n` +
      `Allowed: ${[...allowed].join(', ')}.\n` +
      `즉시 다음 대체로 바꿔 다시 emit (절대 package.json 수정 X — protected file):\n` +
      `${hintLines}\n` +
      `위 안내가 없는 패키지는 'notes'에 사유만 기록하고 응답에서 제거.`
    );
    err.code = 'UNAUTHORIZED_DEPS';
    err.violations = violations;
    throw err;
  }

  return { violations };
}

/**
 * D64 (2026-05-15): 위반 패키지 → 구체적 대체 코드/방법 mapping.
 * validateAllowedDeps의 hint + agent inline retry의 fix prompt에 inject.
 *
 * 추가 기준: LLM이 자주 시도하는 패키지 (학습 데이터 빈도 높은 것). 의미가 명확히
 * 다른 패키지(jsonwebtoken 등)는 "PoC 스코프 밖" 안내. 호환 alias(bcryptjs→bcrypt)는
 * 별도 lib/dep_autofix.js가 *자동 치환*하므로 여기 도달하지 않음.
 */
const REPLACEMENT_HINTS = {
  bcryptjs: "require('bcrypt')로 정확히 변경 (bcryptjs는 별도 패키지, API 동일).",
  'email-validator': "regex로 직접: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)",
  validator: "regex 또는 직접 if/else 검사로 처리.",
  joi: "직접 if/else 검사 + regex로 입력 검증.",
  zod: "직접 if/else 검사 + regex로 입력 검증.",
  yup: "직접 if/else 검사 + regex로 입력 검증.",
  axios: "Node 18+ global fetch 또는 builtin require('https'). FE는 fetch만.",
  'node-fetch': "Node 18+ global fetch. require/import 자체 불필요.",
  jsonwebtoken: "본 PoC 스코프 밖. notes에 사유만 기록, 코드는 만들지 말 것.",
  uuid: "builtin crypto.randomUUID() 사용.",
  lodash: "표준 Array.prototype.* / Object.* / 직접 구현.",
  ramda: "표준 Array.prototype.* / 직접 구현.",
  moment: "builtin Date 사용.",
  'date-fns': "builtin Date 사용.",
  'styled-components': "FE는 인라인 style 또는 plain CSS만.",
  '@emotion/react': "FE는 인라인 style 또는 plain CSS만.",
  '@emotion/styled': "FE는 인라인 style 또는 plain CSS만.",
  tailwindcss: "인라인 style 또는 plain CSS로 처리.",
  clsx: "직접 string concat: classes.filter(Boolean).join(' ')",
  classnames: "직접 string concat: classes.filter(Boolean).join(' ')",
  'react-router-dom': "단일 페이지 또는 useState 기반 조건부 렌더링.",
  'react-hook-form': "useState로 직접 controlled form.",
  formik: "useState로 직접 controlled form.",
  'react-icons': "SVG 인라인 또는 텍스트로 대체.",
  '@mui/icons-material': "SVG 인라인 또는 텍스트로 대체.",
  redux: "useState/useReducer 사용. 외부 state 관리 라이브러리 금지.",
  zustand: "useState/useReducer 사용. 외부 state 관리 라이브러리 금지.",
  'crypto-js': "FE에서 비밀번호 해싱 자체가 안티패턴. 평문을 BE에 전송, BE가 bcrypt 처리.",
};

module.exports = { abridgeExistingFiles, abridgeForRetry, dropProtectedFiles, validateAllowedDeps, REPLACEMENT_HINTS };
