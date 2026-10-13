import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const cli = new URL('../bin/pi-overwatch.js', import.meta.url).pathname;

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-hook-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('Claude hook returns quickly when the tmux server hangs', () => withRoot((root) => {
  writeFileSync(join(root, 'tmux'), '#!/bin/sh\nexec sleep 3\n', { mode: 0o755 });
  const env = { ...process.env, HOME: root, PI_OVERWATCH_DIR: root, PATH: `${root}:${process.env.PATH}`, TMUX: '/tmp/fake,1,0', TMUX_PANE: '%1' };
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: root, prompt: 'hello' });

  const started = Date.now();
  execFileSync(process.execPath, [cli, 'claude-hook'], { input: payload, env });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 2000, `hook took ${elapsed}ms`);
  const [file] = readdirSync(join(root, 'agents'));
  const state = JSON.parse(readFileSync(join(root, 'agents', file), 'utf8'));
  assert.equal(state.status, 'working');
  assert.equal(state.summary, 'hello');
}));

test('installer gives hooks a 10s backstop timeout', () => withRoot((root) => {
  const out = execFileSync(process.execPath, [cli, 'install-claude-hooks', '--dry-run'], {
    encoding: 'utf8', env: { ...process.env, HOME: root },
  });
  const settings = JSON.parse(out);
  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) assert.equal(entry.hooks[0].timeout, 10);
  }
}));
