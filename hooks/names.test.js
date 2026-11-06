import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tmuxTitleArgs, tmuxTitleFor } from './names.js';

const worker = 'pax-worker-0303f0c0-22a7-4012-9822-931c2e65909f-g13';

test('tmux title: only generated sessions, cleared when agents share one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentwatch-names-'));
  try {
    const me = { agentId: 'me', sessionName: 'Fix the build', tmux: { sessionName: worker } };
    assert.deepEqual(tmuxTitleFor(me, dir), { session: worker, title: 'Fix the build' });
    assert.equal(tmuxTitleFor({ ...me, tmux: { sessionName: 'personal-0' } }, dir), undefined);
    assert.equal(tmuxTitleFor({ ...me, sessionName: '1767de67' }, dir), undefined);

    writeFileSync(join(dir, 'gone.json'), JSON.stringify({ agentId: 'gone', status: 'offline', tmux: { sessionName: worker } }));
    assert.equal(tmuxTitleFor(me, dir).title, 'Fix the build');
    writeFileSync(join(dir, 'other.json'), JSON.stringify({ agentId: 'other', status: 'done', pid: process.pid, tmux: { sessionName: worker } }));
    assert.deepEqual(tmuxTitleFor(me, dir), { session: worker, title: undefined });

    assert.deepEqual(tmuxTitleArgs({ session: 's', title: 'T' }), ['set-option', '-t', '=s:', '@pax-supervised-title', 'T']);
    assert.deepEqual(tmuxTitleArgs({ session: 's', title: undefined }), ['set-option', '-u', '-t', '=s:', '@pax-supervised-title']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
