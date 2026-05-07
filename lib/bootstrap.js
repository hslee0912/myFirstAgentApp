/**
 * One-time bootstrap of FE/ and BE/ skeletons. (idempotent)
 *
 * ============================================================
 * ⚠️ STACK MAINTENANCE NOTE
 * ============================================================
 * This file no longer hardcodes the FE/BE tech stack — it reads
 * everything from `lib/stack.config.json` and copies templates from
 * `lib/stack_templates/<AREA>/`.
 *
 * To swap a stack (e.g. FE → Phaser.js, BE → Spring Boot):
 *   1) lib/stack.config.json
 *      - Update `displayName`, `install.command`, `lint.{stage1,stage2,stage3}`,
 *        `agent.*`, `eslintConfig` for the area.
 *   2) lib/stack_templates/<AREA>/
 *      - Replace placeholder files with new-stack equivalents
 *        (e.g. pom.xml + src/main/java/.../Application.java for Spring Boot).
 *
 * Files that should NOT need editing when swapping stacks:
 *   - lib/bootstrap.js (this file)
 *   - agents/lint_agent.js
 *   - agents/be_agent.js / fe_agent.js
 *   - lib/stack.js
 *
 * Other places that may need a touch (rare):
 *   - rules/code_convention.md (§6 test framework name, §10 stack consistency)
 *   - README.md (installation / run guide)
 *
 * See README.md "스택 변경 체크리스트" for the full procedure.
 * ============================================================
 *
 * Bootstrap is called by Orchestrator at every run, but is idempotent:
 *   - File-level guard: writeIfMissing only writes when the path is missing.
 *   - Install guard: npm install only runs if node_modules is missing.
 * Therefore a healthy second-run does almost nothing.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const stack = require('./stack');

const ROOT = path.resolve(__dirname, '..');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

/**
 * Recursively list every file under `dir` (relative paths from `dir`).
 */
function listAllFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const queue = [{ abs: dir, rel: '' }];
  while (queue.length) {
    const { abs, rel } = queue.pop();
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push({ abs: childAbs, rel: childRel });
      else out.push(childRel);
    }
  }
  return out;
}

function copyFileIfMissing(src, dst) {
  if (fs.existsSync(dst)) return false;
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

/**
 * Copy every file from <area>'s template dir into <ROOT>/<area>/, preserving subpaths.
 * Skipped per-file if destination exists.
 */
function bootstrapArea(area) {
  const cfg = stack.get(area);
  const templateRoot = stack.templateDir(area);
  const targetRoot = path.join(ROOT, area);
  ensureDir(targetRoot);

  const created = [];
  if (!fs.existsSync(templateRoot)) {
    throw new Error(`[bootstrap] template dir missing: ${templateRoot}`);
  }
  for (const rel of listAllFiles(templateRoot)) {
    const src = path.join(templateRoot, rel);
    const dst = path.join(targetRoot, rel);
    if (copyFileIfMissing(src, dst)) created.push(`${area}/${rel}`);
  }
  return { area, displayName: cfg.displayName, created };
}

function npmInstallIfMissing(area) {
  const cfg = stack.get(area);
  const cwd = path.join(ROOT, area);
  const checkAbs = path.join(cwd, cfg.install.checkPath);
  if (fs.existsSync(checkAbs)) return false;
  const [cmd, ...args] = cfg.install.command;
  console.log(`[bootstrap] installing dependencies in ${area}/ ...`);
  execSync(`${cmd} ${args.map((a) => JSON.stringify(a)).join(' ')}`, {
    cwd,
    stdio: 'inherit',
    shell: true,
    windowsHide: true,
  });
  return true;
}

/**
 * Run all bootstrap steps (idempotent).
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.install=true] - run `npm install` (or area-specific install) if not yet installed
 */
async function runBootstrap(opts = {}) {
  const install = opts.install !== false;
  const cfg = stack.loadAll();
  const areas = Object.keys(cfg).filter((k) => !k.startsWith('_'));

  const results = [];
  for (const area of areas) {
    results.push(bootstrapArea(area));
  }

  if (install) {
    for (const area of areas) {
      npmInstallIfMissing(area);
    }
  }

  return results;
}

module.exports = { runBootstrap, bootstrapArea };

if (require.main === module) {
  runBootstrap().then(
    (r) => {
      console.log('[bootstrap] done.');
      for (const a of r) {
        console.log(`  ${a.area} (${a.displayName}): ${a.created.length} files created`);
      }
      process.exit(0);
    },
    (e) => {
      console.error('[bootstrap] failed:', e);
      process.exit(1);
    }
  );
}
