import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stateDir } from './state-dir.js';

test('state folder: new path, old path while only it exists, env overrides', () => {
  const home = mkdtempSync(join(tmpdir(), 'agentwatch-dir-'));
  const saved = { HOME: process.env.HOME, A: process.env.AGENTWATCH_DIR, P: process.env.PI_OVERWATCH_DIR };
  delete process.env.AGENTWATCH_DIR;
  delete process.env.PI_OVERWATCH_DIR;
  process.env.HOME = home;
  try {
    const current = join(home, '.local/state/agentwatch');
    const legacy = join(home, '.pi/overwatch');
    assert.equal(stateDir(), current);
    mkdirSync(legacy, { recursive: true });
    assert.equal(stateDir(), legacy);
    mkdirSync(current, { recursive: true });
    assert.equal(stateDir(), current);
    process.env.PI_OVERWATCH_DIR = '/old-env';
    assert.equal(stateDir(), '/old-env');
    process.env.AGENTWATCH_DIR = '/new-env';
    assert.equal(stateDir(), '/new-env');
  } finally {
    for (const [k, v] of [['HOME', saved.HOME], ['AGENTWATCH_DIR', saved.A], ['PI_OVERWATCH_DIR', saved.P]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
