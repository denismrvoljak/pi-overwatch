import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const cli = new URL('./pi-overwatch.js', import.meta.url).pathname;

test('install-tmux adds one source block, survives re-runs, and uninstalls cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-tmux-'));
  try {
    // A tmux that is never running, so the installer does not try to reload.
    writeFileSync(join(root, 'tmux'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const original = 'set -g mouse on\nset -g status-format[1] "mine"\n';
    writeFileSync(join(root, '.tmux.conf'), original);
    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: '', PATH: `${root}:${process.env.PATH}` };
    const run = (...args) => execFileSync(process.execPath, [cli, 'install-tmux', ...args], { encoding: 'utf8', env });

    const first = run();
    assert.match(first, /Added a source-file block/);
    assert.match(first, /may conflict:\n  set -g status-format\[1\] "mine"/);

    const conf = readFileSync(join(root, '.tmux.conf'), 'utf8');
    assert.equal(conf.match(/source-file ~\/\.config\/tmux\/overwatch\.conf/g).length, 1);
    assert.equal(readFileSync(join(root, '.tmux.conf.overwatch-backup'), 'utf8'), original);

    const generated = readFileSync(join(root, '.config/tmux/overwatch.conf'), 'utf8');
    assert.match(generated, /#\('[^']*node' '[^']*pi-overwatch\.js' statusline\)/);
    assert.doesNotMatch(generated, /#\(pi-overwatch /);

    assert.match(run(), /already sources it/);
    assert.equal(readFileSync(join(root, '.tmux.conf'), 'utf8'), conf);

    assert.match(run('--command', 'pi-overwatch'), /Wrote/);
    assert.match(readFileSync(join(root, '.config/tmux/overwatch.conf'), 'utf8'), /#\(pi-overwatch statusline\)/);

    run('--uninstall');
    assert.equal(readFileSync(join(root, '.tmux.conf'), 'utf8'), original);
    assert.ok(!existsSync(join(root, '.config/tmux/overwatch.conf')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
