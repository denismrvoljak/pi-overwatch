import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { programStatusSequence, wrapForTmux } from './program-status.js';

const cli = new URL('../bin/pi-overwatch.js', import.meta.url).pathname;
const b64 = (text) => Buffer.from(text).toString('base64');

test('maps Overwatch states onto OSC 7501 reports', () => {
  assert.equal(
    programStatusSequence({ status: 'blocked', kind: 'permission', app: 'claude-code', id: 'a1', title: 'api', msg: 'Needs\npermission' }),
    `\x1b]7501;state=blocked:kind=permission:id=a1:app=claude-code:title=${b64('api')}:msg=${b64('Needs permission')}\x1b\\`,
  );
  assert.equal(programStatusSequence({ status: 'working', progress: 40 }), '\x1b]7501;state=working:progress=40\x1b\\');
  assert.equal(programStatusSequence({ status: 'done', progress: 40, kind: 'auth' }), '\x1b]7501;state=done\x1b\\');
  assert.equal(programStatusSequence({ status: 'offline', id: 'a1', title: 'api' }), '\x1b]7501;state=clear:id=a1\x1b\\');
  assert.equal(programStatusSequence({ status: 'stale' }), undefined);
  assert.equal(wrapForTmux('\x1b]7501;state=idle\x1b\\'), '\x1bPtmux;\x1b\x1b]7501;state=idle\x1b\x1b\\\x1b\\');
});

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-status-'));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const hook = (root, payload, extraEnv = {}) =>
  execFileSync(process.execPath, [cli, 'claude-hook'], {
    input: JSON.stringify({ session_id: 's1', cwd: root, ...payload }),
    env: { ...process.env, PI_OVERWATCH_DIR: root, TMUX: '', ...extraEnv },
  });

const readState = (root) => {
  const [file] = readdirSync(join(root, 'agents'));
  return JSON.parse(readFileSync(join(root, 'agents', file), 'utf8'));
};

test('Claude permission prompts become a blocked status with a kind', () => withRoot((root) => {
  hook(root, { hook_event_name: 'UserPromptSubmit', prompt: 'go' });
  hook(root, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  let state = readState(root);
  assert.equal(state.status, 'blocked');
  assert.equal(state.kind, 'permission');
  assert.equal(state.blocked, undefined);

  hook(root, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_response: {} });
  state = readState(root);
  assert.equal(state.status, 'working');
  assert.equal(state.kind, undefined);

  hook(root, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  hook(root, { hook_event_name: 'Stop' });
  state = readState(root);
  assert.equal(state.status, 'done');
  assert.equal(state.summary, 'Idle');
}));

test('legacy blocked flags still read as blocked', () => withRoot((root) => {
  mkdirSync(join(root, 'agents'));
  const now = new Date().toISOString();
  writeFileSync(join(root, 'agents/old.json'), JSON.stringify({
    agentId: 'old', sessionName: 'legacy', status: 'working', phase: 'waiting', blocked: true,
    updatedAt: now, startedAt: now, lastHeartbeatAt: now,
  }));
  const line = execFileSync(process.execPath, [cli, 'statusline', '--plain', '--no-source'], {
    encoding: 'utf8', env: { ...process.env, PI_OVERWATCH_DIR: root, HOME: root, TMUX: '' },
  });
  assert.match(line, /^⏸ legacy permission \d\d:\d\d\n$/);
}));

test('Claude hook writes reports to the agent terminal when enabled', { skip: process.platform !== 'darwin' }, () => withRoot((root) => {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ programStatus: { emit: true } }));
  writeFileSync(join(root, 'payload.json'), JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: root, prompt: 'go' }));
  const out = join(root, 'pty.out');
  // `script` gives the hook's parent shell a real pty, like Claude Code's own terminal.
  execFileSync('script', ['-q', out, 'sh', '-c', `"${process.execPath}" "${cli}" claude-hook < "${join(root, 'payload.json')}"`], {
    stdio: 'ignore', env: { ...process.env, PI_OVERWATCH_DIR: root, TMUX: '' },
  });
  assert.match(readFileSync(out, 'latin1'), /\x1b\]7501;state=working:id=[0-9a-f]{12}:app=claude-code:title=[^:]+:msg=Z28=\x1b\\/);
  assert.ok(readState(root).tty.startsWith('/dev/'));
}));

test('records stay until the agent ends, then drop out', () => withRoot((root) => {
  mkdirSync(join(root, 'agents'));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const write = (id, extra) => writeFileSync(join(root, `agents/${id}.json`), JSON.stringify({
    agentId: id, sessionName: id, status: 'done', updatedAt: hourAgo, lastHeartbeatAt: hourAgo, ...extra,
  }));
  write('live', { pid: process.pid });
  // A pid well above any real one: the agent died without saying so.
  write('crashed', { pid: 2 ** 22 + 12345 });
  write('ended', { status: 'offline', pid: process.pid });
  const statusline = (extraEnv = {}) => execFileSync(process.execPath, [cli, 'statusline', '--plain', '--no-source'], {
    encoding: 'utf8', env: { ...process.env, PI_OVERWATCH_DIR: root, HOME: root, TMUX: '', ...extraEnv },
  });
  assert.equal(statusline(), '✓ live\n');
  assert.equal(statusline({ PI_OVERWATCH_STATUS_TTL_MS: '60000' }), '○ idle\n');
}));
