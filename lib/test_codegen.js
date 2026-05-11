/**
 * Deterministic smoke-test generator (no LLM).
 *
 * Replaces the LLM's responsibility of writing unit tests. The LLM produces
 * business code only; this module analyzes the code's exports via regex and
 * emits a minimal smoke test that verifies the export is *runnable*.
 *
 * What we generate:
 *   - React component (default export of a function returning JSX-ish):
 *     render(<Component />) and assert container is not empty.
 *   - Named function export:
 *     typeof check (`expect(typeof fnName).toBe('function')`).
 *   - Default identifier export of a const/var:
 *     truthy check.
 *
 * What we deliberately do NOT do:
 *   - Generate tests against business behavior. spec-driven assertions are
 *     LLM territory; this module sticks to "does it load and not throw."
 *   - Touch placeholder *.test.{js,jsx} files (skipped by isTestFile()).
 *   - Touch protected config files (caller already filtered those upstream).
 *
 * Decision provenance: introduced when Stage 3 (vitest) fails were traced
 * to LLM's incorrect RTL API usage (e.g. getByText vs getAllByText). Moving
 * test creation to a deterministic tool guarantees Stage 3 stability for the
 * smoke layer; deeper behavior tests, if needed, become a separate phase.
 */
'use strict';

const path = require('path');

/** Path is a test file (already covered by placeholder or earlier round). */
function isTestFile(p) {
  return /\.test\.(js|jsx|ts|tsx)$/.test(p);
}

/** Path is a JS/JSX source file we should consider for codegen. */
function isCodeFile(p) {
  return /\.(js|jsx)$/.test(p) && !isTestFile(p);
}

/** Best-guess test path next to the source path. */
function testPathFor(p) {
  const dir = path.posix.dirname(p);
  const base = path.posix.basename(p);
  const dot = base.lastIndexOf('.');
  const stem = base.slice(0, dot);
  const ext = base.slice(dot); // includes dot
  return `${dir}/${stem}.test${ext}`;
}

// ---------------- export extraction (regex-based) ----------------

/**
 * Find all *named* exports. Returns array of { name, kind }.
 * Patterns covered:
 *   export function foo() {}      → { name: 'foo', kind: 'function' }
 *   export async function foo()   → { name: 'foo', kind: 'function' }
 *   export const foo = ...        → { name: 'foo', kind: 'const' }
 *   export let foo = ...          → { name: 'foo', kind: 'const' }
 *   export class Foo              → { name: 'Foo', kind: 'class' }
 *   export { foo, bar }           → { name: 'foo' }, { name: 'bar' }
 */
function extractNamedExports(code) {
  const out = [];
  const seen = new Set();

  const re1 = /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(re1)) {
    if (!seen.has(m[1])) { out.push({ name: m[1], kind: 'function' }); seen.add(m[1]); }
  }

  const re2 = /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(re2)) {
    if (!seen.has(m[1])) { out.push({ name: m[1], kind: 'const' }); seen.add(m[1]); }
  }

  const re3 = /export\s+class\s+([A-Za-z_$][\w$]*)/g;
  for (const m of code.matchAll(re3)) {
    if (!seen.has(m[1])) { out.push({ name: m[1], kind: 'class' }); seen.add(m[1]); }
  }

  // export { foo, bar as baz }
  const re4 = /export\s*\{([^}]+)\}/g;
  for (const m of code.matchAll(re4)) {
    const inner = m[1];
    for (const piece of inner.split(',')) {
      const part = piece.trim();
      if (!part) continue;
      const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(part);
      const idMatch = /^([A-Za-z_$][\w$]*)$/.exec(part);
      const name = asMatch ? asMatch[2] : (idMatch ? idMatch[1] : null);
      if (name && name !== 'default' && !seen.has(name)) {
        out.push({ name });
        seen.add(name);
      }
    }
  }

  return out;
}

/**
 * Find the default export. Returns { kind, name } or null.
 *   export default function Foo() {}         → { kind: 'function', name: 'Foo' }
 *   export default function() {}             → { kind: 'function', name: null }
 *   export default class Foo {}              → { kind: 'class', name: 'Foo' }
 *   export default Foo                       → { kind: 'identifier', name: 'Foo' }
 *   (no default)                             → null
 */
function extractDefaultExport(code) {
  const f1 = /export\s+default\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(code);
  if (f1) return { kind: 'function', name: f1[1] };

  const f2 = /export\s+default\s+(?:async\s+)?function\s*\(/.exec(code);
  if (f2) return { kind: 'function', name: null };

  const c1 = /export\s+default\s+class\s+([A-Za-z_$][\w$]*)/.exec(code);
  if (c1) return { kind: 'class', name: c1[1] };

  const i1 = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/m.exec(code);
  if (i1) return { kind: 'identifier', name: i1[1] };

  return null;
}

/**
 * Heuristic — does the default export look like a React component?
 *   - identifier name starts with uppercase (PascalCase), AND
 *   - file is .jsx OR file body contains JSX (`<Tag` or `</Tag>`).
 */
function looksLikeReactComponent(srcPath, code, defaultExport) {
  if (!defaultExport || !defaultExport.name) return false;
  if (!/^[A-Z]/.test(defaultExport.name)) return false;
  if (srcPath.endsWith('.jsx')) return true;
  return /<[A-Za-z][\w]*[\s/>]/.test(code);
}

// ---------------- test code emit ----------------

function emitReactComponentTest(componentName, importPath) {
  return `import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import ${componentName} from './${importPath}';

describe('${componentName} (auto-generated smoke test)', () => {
  it('renders without crashing and produces non-empty output', () => {
    const { container } = render(<${componentName} />);
    expect(container).toBeTruthy();
    expect(container.firstChild).not.toBeNull();
  });
});
`;
}

function emitFunctionLibTest(srcPath, namedExports, defaultExport, importPath) {
  // Build named imports list
  const named = namedExports.map((e) => e.name);
  const importParts = [];
  if (defaultExport && defaultExport.name) importParts.push(defaultExport.name);
  const namedClause = named.length ? `{ ${named.join(', ')} }` : '';

  // Use BE jest convention if .js, FE vitest if .jsx
  const isJsx = srcPath.endsWith('.jsx');
  const testRunnerImport = isJsx
    ? `import { describe, it, expect } from 'vitest';\n`
    : ''; // BE uses jest globals

  let importLine;
  if (importParts.length && namedClause) {
    importLine = `const ${importParts[0]} = require('./${importPath}');\nconst ${namedClause} = require('./${importPath}');`;
  } else if (importParts.length) {
    importLine = `const ${importParts[0]} = require('./${importPath}');`;
  } else if (namedClause) {
    importLine = `const ${namedClause} = require('./${importPath}');`;
  } else {
    importLine = `require('./${importPath}');`;
  }
  // jsx -> ESM import; .js -> CJS require (matches stack rule)
  const importBlock = isJsx
    ? `import ${importParts[0] || ''}${importParts[0] && namedClause ? ', ' : ''}${namedClause} from './${importPath}';`
    : importLine;

  const assertions = [];
  if (defaultExport && defaultExport.name) {
    assertions.push(`    expect(${defaultExport.name}).toBeDefined();`);
  }
  for (const e of namedExports) {
    if (e.kind === 'function') {
      assertions.push(`    expect(typeof ${e.name}).toBe('function');`);
    } else if (e.kind === 'class') {
      assertions.push(`    expect(typeof ${e.name}).toBe('function');`);
    } else {
      assertions.push(`    expect(${e.name}).toBeDefined();`);
    }
  }
  if (assertions.length === 0) {
    assertions.push(`    expect(true).toBe(true); // module loaded`);
  }

  const body = `describe('${path.posix.basename(srcPath)} (auto-generated smoke test)', () => {
  it('exposes its declared exports', () => {
${assertions.join('\n')}
  });
});`;

  return `${testRunnerImport}${importBlock}

${body}
`;
}

// ---------------- main entry ----------------

/**
 * Generate smoke test files for the given source files map.
 *
 * @param {Object<string,string>} files - { srcPath: code } produced by an LLM Agent
 * @returns {Object<string,string>} { testPath: testCode } for new tests only.
 *   - never overwrites paths that already exist as keys in the input map
 *     (caller can merge with input safely).
 *   - skips files that are already test files.
 *   - skips files with no detectable exports.
 */
function generateSmokeTests(files) {
  const out = {};
  const inputPaths = new Set(Object.keys(files || {}));
  for (const [srcPath, code] of Object.entries(files || {})) {
    if (!isCodeFile(srcPath)) continue;

    const namedExports = extractNamedExports(code || '');
    const defaultExport = extractDefaultExport(code || '');
    if (!defaultExport && namedExports.length === 0) continue;

    const testPath = testPathFor(srcPath);
    if (inputPaths.has(testPath)) continue; // LLM already provided one (rare)

    const importStem = path.posix.basename(srcPath).replace(/\.(js|jsx)$/, '');
    if (looksLikeReactComponent(srcPath, code || '', defaultExport)) {
      out[testPath] = emitReactComponentTest(defaultExport.name, importStem);
    } else {
      out[testPath] = emitFunctionLibTest(srcPath, namedExports, defaultExport, importStem);
    }
  }
  return out;
}

/**
 * Defense-in-depth: silently remove agent-generated test files from the LLM
 * response BEFORE validatePaths runs. Tests are now produced by
 * generateSmokeTests (deterministic), so any *.test.* in the LLM response is
 * a system-prompt violation that we'd rather drop than honor.
 *
 * Returns { files, dropped } so the agent can record dropped paths in its
 * output_json audit trail.
 *
 * @param {Object<string,string>} files
 * @param {string} [agentLabel]
 * @returns {{ files: Object<string,string>, dropped: string[] }}
 */
function dropAgentGeneratedTests(files, agentLabel = 'Agent') {
  const out = {};
  const dropped = [];
  for (const [path, content] of Object.entries(files || {})) {
    if (isTestFile(path)) {
      dropped.push(path);
      console.warn(
        `[${agentLabel}] dropped agent-generated test (system auto-generates): ${path}`
      );
    } else {
      out[path] = content;
    }
  }
  return { files: out, dropped };
}

module.exports = {
  isTestFile,
  isCodeFile,
  testPathFor,
  extractNamedExports,
  extractDefaultExport,
  looksLikeReactComponent,
  generateSmokeTests,
  dropAgentGeneratedTests,
};
