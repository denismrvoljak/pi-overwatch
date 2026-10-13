import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const cli = new URL('../bin/pi-overwatch.js', import.meta.url).pathname;

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-codex-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const env = (root) => ({ ...process.env, HOME: root, PI_OVERWATCH_DIR: root, TMUX: '' });

const hook = (root, payload) =>
  execFileSync(process.execPath, [cli, 'codex-hook'], {
    encoding: 'utf8',
    input: JSON.stringify({ session_id: 'c1', turn_id: 't1', cwd: root, ...payload }),
    env: env(root),
  });

const readState = (root) => {
  const [file] = readdirSync(join(root, 'agents'));
  return JSON.parse(readFileSync(join(root, 'agents', file), 'utf8'));
};

test('Codex hooks drive working, blocked, interrupted and done states', () => withRoot((root) => {
  // Codex adds hook stdout to the model's context, so the hook must print nothing.
  assert.equal(hook(root, { hook_event_name: 'SessionStart', source: 'startup' }), '');
  assert.equal(readState(root).source, 'codex');
  assert.equal(readState(root).status, 'idle');

  assert.equal(hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'fix tests' }), '');
  assert.equal(readState(root).status, 'working');

  hook(root, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['bash', '-lc', 'npm test'] } });
  assert.equal(readState(root).summary, 'Running npm test');

  hook(root, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
  let state = readState(root);
  assert.equal(state.status, 'blocked');
  assert.equal(state.kind, 'permission');
  assert.equal(state.summary, 'Approve: Running rm -rf build');

  hook(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: {} });
  assert.equal(readState(root).status, 'working');

  hook(root, { hook_event_name: 'Interrupt' });
  state = readState(root);
  assert.equal(state.status, 'idle');
  assert.equal(state.summary, 'Interrupted');

  hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'again' });
  hook(root, { hook_event_name: 'Stop' });
  assert.equal(readState(root).status, 'done');

  const line = execFileSync(process.execPath, [cli, 'statusline', '--plain'], { encoding: 'utf8', env: env(root) });
  assert.match(line, /^◇ ✓ /);
  const codexOnly = execFileSync(process.execPath, [cli, 'statusline', '--plain', '--source', 'claude-code'], { encoding: 'utf8', env: env(root) });
  assert.match(codexOnly, /idle/);

  hook(root, { hook_event_name: 'SessionEnd', reason: 'other' });
  assert.equal(readState(root).status, 'offline');
}));

test('install-codex-hooks writes ~/.codex/hooks.json and leaves other hooks alone', () => withRoot((root) => {
  const run = (...args) => execFileSync(process.execPath, [cli, 'install-codex-hooks', ...args], { encoding: 'utf8', env: env(root) });
  assert.match(run(), /approve the new hooks in \/hooks/);
  const file = join(root, '.codex/hooks.json');
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(settings.hooks).sort(), [
    'Interrupt', 'PermissionRequest', 'PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'UserPromptSubmit',
  ]);
  assert.equal(settings.hooks.PermissionRequest[0].matcher, '*');
  assert.equal(settings.hooks.Stop[0].hooks[0].command, 'pi-overwatch codex-hook');
  assert.equal(settings.hooks.Stop[0].hooks[0].timeout, 10);
  assert.equal(settings.hooks.SessionEnd[0].hooks[0].timeout, undefined);

  run();
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).hooks.Stop.length, 1);
  run('--uninstall');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {});
}));
