/**
 * Filesystem helpers for FE/BE Agents.
 *
 * Path safety: every write must resolve to a path under the project root AND
 * to the agent's allowed base (FE/ or BE/). Anything else throws.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Resolve a relative-to-root path and assert it is inside the given base folder.
 * @param {string} relPath - e.g. "BE/services/user_service.js"
 * @param {string} base    - "FE" or "BE"
 */
function resolveSafe(relPath, base) {
  const baseAbs = path.join(ROOT, base);
  const target = path.resolve(ROOT, relPath);
  if (!isInside(baseAbs, target) && target !== baseAbs) {
    throw new Error(`[fs_util] path '${relPath}' is outside ${base}/`);
  }
  return target;
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeFileSafe(relPath, content, base) {
  const abs = resolveSafe(relPath, base);
  ensureDir(path.dirname(abs));
  fs.writeFileSync(abs, content, 'utf8');
}

function readIfExists(relPath, base) {
  const abs = resolveSafe(relPath, base);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

/**
 * Recursively list files under <base>/ that match the given extension list.
 * Skips node_modules, dist, coverage.
 */
function listFiles(base, extensions = []) {
  const baseAbs = path.join(ROOT, base);
  if (!fs.existsSync(baseAbs)) return [];
  const out = [];
  const stack = [baseAbs];
  const skip = new Set(['node_modules', 'dist', 'coverage', '.git']);
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (extensions.length === 0 || extensions.some((e) => entry.name.endsWith(e))) {
        out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  }
  return out;
}

/**
 * Build a snapshot { "BE/foo.js": "<content>", ... } for the given file list.
 */
function snapshot(files) {
  const out = {};
  for (const f of files) {
    const abs = path.resolve(ROOT, f);
    if (fs.existsSync(abs)) out[f] = fs.readFileSync(abs, 'utf8');
  }
  return out;
}

module.exports = { ROOT, resolveSafe, writeFileSafe, readIfExists, listFiles, snapshot };
