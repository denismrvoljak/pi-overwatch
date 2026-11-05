import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

test('statusline skips generated names for readable ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-label-'));
  try {
    mkdirSync(join(root, 'agents'));
    const now = new Date().toISOString();
    const agents = {
      pax: { tmux: { sessionName: 'pax-worker-0303f0c0-22a7-4012-9822-931c2e65909f-g13' }, sessionName: 'Make ML discovery agent-friendly with reproducible runs', cwd: '/w/dat-1554-make-ml' },
      cc: { sessionName: '1767de67', cwd: '/home/x/github/dotagents' },
      main: { cwd: '/home/x/github/pax/main' },
      named: { tmux: { sessionName: 'personal' }, sessionName: 'abc', cwd: '/home/x' },
    };
    for (const [id, a] of Object.entries(agents)) {
      writeFileSync(join(root, 'agents', `${id}.json`), JSON.stringify({ agentId: id, status: 'done', updatedAt: now, ...a }));
    }
    const out = execFileSync(process.execPath, [new URL('./pi-overwatch.js', import.meta.url).pathname, 'statusline', '--plain', '--no-source'], {
      encoding: 'utf8', env: { ...process.env, HOME: root, PI_OVERWATCH_DIR: root },
    });
    assert.match(out, /Make ML discovery agent…/);
    assert.match(out, /dotagents/);
    assert.match(out, /✓ pax\b/);
    assert.match(out, /personal/);
    assert.doesNotMatch(out, /pax-worker|1767de67|main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
