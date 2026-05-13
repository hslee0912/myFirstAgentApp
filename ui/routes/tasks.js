/**
 * /api/tasks — read-only views over log_agent_decisions / log_agent_runs /
 * log_task_state, plus the current shared/api_contract.json (expanded).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../../lib/db');
const { normalizeContract } = require('../../lib/api_test');
const { checkResumeEligibility } = require('../../lib/resume_helper');
const { ROOT } = require('./_context');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const rows = await db.query(
      'SELECT id, task_id, final_verdict, final_result_text, created_at, updated_at ' +
      'FROM log_agent_decisions ORDER BY id DESC LIMIT 20'
    );
    res.json({ tasks: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:task_id', async (req, res) => {
  try {
    const { task_id } = req.params;
    const [decisions, runs] = await Promise.all([
      db.query(
        'SELECT id, task_id, final_verdict, final_result_text, created_at, updated_at ' +
        'FROM log_agent_decisions WHERE task_id = ? LIMIT 1',
        [task_id],
      ),
      db.query(
        'SELECT id, agent_name, target, status, input_json, output_json, started_at, ended_at ' +
        'FROM log_agent_runs WHERE task_id = ? ORDER BY id ASC',
        [task_id],
      ),
    ]);
    const decision = decisions[0] || null;
    let states = [];
    if (decision) {
      states = await db.query(
        'SELECT id, target, status, retry_count, failed_stage, fix_instructions, stage_logs, ' +
        'created_at, updated_at FROM log_task_state WHERE decision_id = ? ORDER BY target ASC',
        [decision.id],
      );
    }

    // D35 (2026-05-14, 옵션 C): resume 가능 여부 + user_request preview
    //   UI가 detail panel에서 🔁 Resume / 📋 prompt에 채우기 버튼 노출 결정용.
    //   eligibility 검증은 DB query 1~2회 (가벼움).
    let resume = { eligible: false, reason: 'no decision', user_request: '' };
    if (decision) {
      const elig = await checkResumeEligibility(task_id);
      resume = {
        eligible: elig.eligible,
        reason: elig.reason,
        user_request: elig.user_request || '',
      };
    }

    res.json({ decision, states, runs, resume });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:task_id/contract', (_req, res) => {
  const p = path.join(ROOT, 'shared', 'api_contract.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'no api_contract.json' });
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    const expanded = normalizeContract(raw, {
      routerDir: path.join(ROOT, 'shared', 'router'),
    });
    res.json({ contract: expanded });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
