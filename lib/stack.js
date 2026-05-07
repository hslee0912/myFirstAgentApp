/**
 * Stack config loader.
 *
 * Single source of truth for stack-specific behavior. Read by:
 *   - lib/bootstrap.js     (templates + install command)
 *   - agents/lint_agent.js (3-stage commands)
 *   - agents/be_agent.js   (system prompt header, allowed deps, snapshot extensions)
 *   - agents/fe_agent.js   (same)
 *
 * To swap a stack (e.g. BE → Spring Boot), edit:
 *   1) lib/stack.config.json — area block (install/lint/agent/eslintConfig)
 *   2) lib/stack_templates/<AREA>/ — placeholder files for that stack
 * No agent code changes should be required.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'stack.config.json');

let _cache = null;

function loadAll() {
  if (_cache) return _cache;
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  _cache = JSON.parse(raw);
  return _cache;
}

/**
 * @param {'FE'|'BE'} area
 */
function get(area) {
  const cfg = loadAll();
  if (!cfg[area]) throw new Error(`stack.config.json: unknown area '${area}'`);
  return cfg[area];
}

/**
 * Absolute path to the template folder for the given area (e.g. lib/stack_templates/BE).
 */
function templateDir(area) {
  return path.join(ROOT, get(area).templateDir);
}

module.exports = { ROOT, CONFIG_PATH, get, loadAll, templateDir };
