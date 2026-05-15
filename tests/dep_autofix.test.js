'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { autoFixDependencyAliases, ALIAS_REPLACEMENTS } = require('../lib/dep_autofix');

test('autoFixDependencyAliases: require(\'bcryptjs\') → require(\'bcrypt\')', () => {
  const files = {
    'BE/src/services/auth_service.js': `'use strict';\nconst bcrypt = require('bcryptjs');\nasync function signup(p) { return bcrypt.hash(p, 10); }\nmodule.exports = { signup };`,
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.match(out['BE/src/services/auth_service.js'], /require\('bcrypt'\)/);
  assert.doesNotMatch(out['BE/src/services/auth_service.js'], /require\('bcryptjs'\)/);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].from, 'bcryptjs');
  assert.equal(replacements[0].to, 'bcrypt');
});

test('autoFixDependencyAliases: 큰따옴표도 처리', () => {
  const files = {
    'BE/src/x.js': `const bcrypt = require("bcryptjs");`,
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.match(out['BE/src/x.js'], /require\("bcrypt"\)/);
  assert.equal(replacements.length, 1);
});

test('autoFixDependencyAliases: ES Modules import도 처리', () => {
  const files = {
    'FE/src/util.js': `import bcrypt from 'bcryptjs';\nexport default bcrypt;`,
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.match(out['FE/src/util.js'], /from 'bcrypt'/);
  assert.doesNotMatch(out['FE/src/util.js'], /bcryptjs/);
  assert.equal(replacements.length, 1);
});

test('autoFixDependencyAliases: mapping 없는 패키지는 그대로', () => {
  const files = {
    'BE/src/x.js': `const joi = require('joi');\nconst axios = require('axios');`,
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.equal(out['BE/src/x.js'], files['BE/src/x.js']);
  assert.equal(replacements.length, 0);
});

test('autoFixDependencyAliases: bcrypt 정확 철자는 건드리지 않음', () => {
  const files = {
    'BE/src/x.js': `const bcrypt = require('bcrypt');\n// bcryptjs 사용 금지 (주석은 영향 X)`,
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.equal(out['BE/src/x.js'], files['BE/src/x.js']);
  assert.equal(replacements.length, 0);
});

test('autoFixDependencyAliases: .js/.jsx 외 확장자는 건드리지 않음', () => {
  const files = {
    'BE/.env.example': `BCRYPTJS=bcryptjs`,
    'shared/api_contract.json': '{ "x": "bcryptjs" }',
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.equal(out['BE/.env.example'], files['BE/.env.example']);
  assert.equal(out['shared/api_contract.json'], files['shared/api_contract.json']);
  assert.equal(replacements.length, 0);
});

test('autoFixDependencyAliases: 한 파일에 여러 alias 모두 처리', () => {
  const files = {
    'BE/src/multi.js': `const a = require('bcryptjs');\nconst b = require('bcryptjs');`,
  };
  const { files: out, replacements } = autoFixDependencyAliases(files);
  assert.equal((out['BE/src/multi.js'].match(/require\('bcrypt'\)/g) || []).length, 2);
  assert.equal(replacements.length, 1);
});

test('ALIAS_REPLACEMENTS 정확성 — bcryptjs → bcrypt 포함', () => {
  assert.equal(ALIAS_REPLACEMENTS.bcryptjs, 'bcrypt');
});
