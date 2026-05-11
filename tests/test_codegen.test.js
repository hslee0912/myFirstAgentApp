/**
 * Unit tests for lib/test_codegen.js — deterministic smoke-test generator.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isTestFile,
  isCodeFile,
  testPathFor,
  extractNamedExports,
  extractDefaultExport,
  looksLikeReactComponent,
  generateSmokeTests,
} = require('../lib/test_codegen');

// ─────────── path helpers ───────────

test('isTestFile: matches .test.js/.test.jsx/.test.ts/.test.tsx', () => {
  assert.equal(isTestFile('a/b/foo.test.js'), true);
  assert.equal(isTestFile('a/b/foo.test.jsx'), true);
  assert.equal(isTestFile('a/b/foo.test.ts'), true);
  assert.equal(isTestFile('a/b/foo.js'), false);
  assert.equal(isTestFile('a/b/foo.jsx'), false);
});

test('isCodeFile: js/jsx that are NOT test files', () => {
  assert.equal(isCodeFile('a/foo.js'), true);
  assert.equal(isCodeFile('a/Foo.jsx'), true);
  assert.equal(isCodeFile('a/foo.test.js'), false);
  assert.equal(isCodeFile('a/foo.json'), false);
  assert.equal(isCodeFile('a/foo.css'), false);
});

test('testPathFor: js → .test.js, jsx → .test.jsx', () => {
  assert.equal(testPathFor('BE/src/server.js'), 'BE/src/server.test.js');
  assert.equal(testPathFor('FE/src/components/X.jsx'), 'FE/src/components/X.test.jsx');
});

// ─────────── extractNamedExports ───────────

test('extractNamedExports: function declarations', () => {
  const code = 'export function foo() {}\nexport async function bar() {}';
  const result = extractNamedExports(code);
  assert.deepEqual(result, [
    { name: 'foo', kind: 'function' },
    { name: 'bar', kind: 'function' },
  ]);
});

test('extractNamedExports: const/let declarations', () => {
  const code = 'export const foo = 1;\nexport let bar = 2;';
  const result = extractNamedExports(code);
  assert.deepEqual(result.map((e) => e.name).sort(), ['bar', 'foo']);
});

test('extractNamedExports: class declaration', () => {
  const code = 'export class FooClass {}';
  const result = extractNamedExports(code);
  assert.deepEqual(result, [{ name: 'FooClass', kind: 'class' }]);
});

test('extractNamedExports: export { ... } block', () => {
  const code = 'function a() {} function b() {} export { a, b };';
  const result = extractNamedExports(code);
  assert.deepEqual(result.map((e) => e.name).sort(), ['a', 'b']);
});

test('extractNamedExports: deduplicates same name', () => {
  const code = 'export function foo() {}\nexport { foo };';
  const result = extractNamedExports(code);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'foo');
});

// ─────────── extractDefaultExport ───────────

test('extractDefaultExport: default function with name', () => {
  const r = extractDefaultExport('export default function Foo() {}');
  assert.deepEqual(r, { kind: 'function', name: 'Foo' });
});

test('extractDefaultExport: default class with name', () => {
  const r = extractDefaultExport('export default class Bar {}');
  assert.deepEqual(r, { kind: 'class', name: 'Bar' });
});

test('extractDefaultExport: default identifier', () => {
  const code = 'function Baz() { return null; }\nexport default Baz';
  const r = extractDefaultExport(code);
  assert.deepEqual(r, { kind: 'identifier', name: 'Baz' });
});

test('extractDefaultExport: anonymous default function', () => {
  const r = extractDefaultExport('export default function() {}');
  assert.deepEqual(r, { kind: 'function', name: null });
});

test('extractDefaultExport: no default', () => {
  assert.equal(extractDefaultExport('export const a = 1;'), null);
});

// ─────────── React component detection ───────────

test('looksLikeReactComponent: PascalCase + .jsx → true', () => {
  assert.equal(
    looksLikeReactComponent('FE/X.jsx', 'export default function X() { return <div />; }', { name: 'X' }),
    true
  );
});

test('looksLikeReactComponent: PascalCase + .js + JSX in body → true', () => {
  assert.equal(
    looksLikeReactComponent('FE/X.js', 'function X() { return <div />; }', { name: 'X' }),
    true
  );
});

test('looksLikeReactComponent: lowercase identifier → false', () => {
  assert.equal(
    looksLikeReactComponent('FE/foo.jsx', 'export default function foo() { return <div />; }', { name: 'foo' }),
    false
  );
});

test('looksLikeReactComponent: no default export → false', () => {
  assert.equal(looksLikeReactComponent('FE/x.jsx', '', null), false);
});

// ─────────── generateSmokeTests ───────────

test('generateSmokeTests: React component → render-based smoke test', () => {
  const files = {
    'FE/src/components/Hello.jsx': 'export default function Hello() { return <h1>hi</h1>; }',
  };
  const result = generateSmokeTests(files);
  const testPath = 'FE/src/components/Hello.test.jsx';
  assert.ok(result[testPath], 'test file generated');
  assert.match(result[testPath], /render\(<Hello \/>\)/);
  assert.match(result[testPath], /vitest/);
});

test('generateSmokeTests: BE module → typeof smoke test', () => {
  const files = {
    'BE/src/services/user_service.js': 'function createUser() {} module.exports = { createUser }; export function createUser2() {}',
  };
  const result = generateSmokeTests(files);
  const testPath = 'BE/src/services/user_service.test.js';
  assert.ok(result[testPath], 'test file generated');
  assert.match(result[testPath], /typeof createUser2/);
});

test('generateSmokeTests: skips .test files', () => {
  const files = {
    'BE/src/x.test.js': 'something',
    'BE/src/y.js': 'export function y() {}',
  };
  const result = generateSmokeTests(files);
  assert.equal(Object.keys(result).length, 1);
  assert.ok(result['BE/src/y.test.js']);
});

test('generateSmokeTests: skips when LLM already provided test', () => {
  const files = {
    'FE/src/X.jsx': 'export default function X() { return <div />; }',
    'FE/src/X.test.jsx': '/* LLM-provided test */',
  };
  const result = generateSmokeTests(files);
  assert.equal(Object.keys(result).length, 0);
});

test('generateSmokeTests: skips file with no detectable exports', () => {
  const files = {
    'BE/src/empty.js': '// just a comment',
  };
  const result = generateSmokeTests(files);
  assert.equal(Object.keys(result).length, 0);
});

test('generateSmokeTests: handles empty/null input', () => {
  assert.deepEqual(generateSmokeTests({}), {});
  assert.deepEqual(generateSmokeTests(null), {});
});

// ─────────── dropAgentGeneratedTests ───────────

const { dropAgentGeneratedTests } = require('../lib/test_codegen');

test('dropAgentGeneratedTests: removes .test.js / .test.jsx files', () => {
  const result = dropAgentGeneratedTests({
    'BE/src/server.js': 'A',
    'BE/src/server.test.js': 'B',
    'FE/src/X.jsx': 'C',
    'FE/src/X.test.jsx': 'D',
  });
  assert.deepEqual(Object.keys(result.files).sort(), ['BE/src/server.js', 'FE/src/X.jsx']);
  assert.deepEqual(result.dropped.sort(), ['BE/src/server.test.js', 'FE/src/X.test.jsx']);
});

test('dropAgentGeneratedTests: keeps non-test files', () => {
  const result = dropAgentGeneratedTests({
    'BE/src/a.js': '1',
    'BE/src/b.js': '2',
  });
  assert.deepEqual(Object.keys(result.files), ['BE/src/a.js', 'BE/src/b.js']);
  assert.deepEqual(result.dropped, []);
});

test('dropAgentGeneratedTests: handles empty/null input', () => {
  assert.deepEqual(dropAgentGeneratedTests({}), { files: {}, dropped: [] });
  assert.deepEqual(dropAgentGeneratedTests(null), { files: {}, dropped: [] });
  assert.deepEqual(dropAgentGeneratedTests(undefined), { files: {}, dropped: [] });
});

test('dropAgentGeneratedTests: also catches .test.ts/.test.tsx', () => {
  const result = dropAgentGeneratedTests({
    'src/a.test.ts': 'A',
    'src/b.test.tsx': 'B',
  });
  assert.deepEqual(Object.keys(result.files), []);
  assert.deepEqual(result.dropped.sort(), ['src/a.test.ts', 'src/b.test.tsx']);
});
