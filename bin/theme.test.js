import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

 test('CLI follows tmux palette, brightness, and explicit overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'overwatch-theme-'));
  try {
    mkdirSync(join(root, '.config'));
    writeFileSync(join(root, '.config/theme-mode'), 'dark\n');
    writeFileSync(join(root, 'tmux'), '#!/bin/sh\ncase "$3" in\n@powerkit_theme) echo "$TEST_FAMILY";;\n@powerkit_theme_variant) echo "$TEST_VARIANT";;\n@pi_overwatch_theme) echo "$TEST_MODE";;\nesac\n', { mode: 0o755 });
    const run = (family, variant, mode = '', args = []) => execFileSync(process.execPath, [new URL('./pi-overwatch.js', import.meta.url).pathname, 'statusline', ...args], {
      encoding: 'utf8', env: { ...process.env, HOME: root, PI_OVERWATCH_DIR: root, PATH: `${root}:${process.env.PATH}`, TEST_FAMILY: family, TEST_VARIANT: variant, TEST_MODE: mode },
    });
    assert.match(run('catppuccin', 'latte'), /#8c8fa1/);
    assert.match(run('catppuccin', 'mocha'), /#7f849c/);
    assert.match(run('rose-pine', 'dawn'), /#797593/);
    assert.match(run('rose-pine', 'moon'), /#908caa/);
    assert.match(run('catppuccin', 'latte', 'dark'), /#7f849c/);
    assert.match(run('catppuccin', 'mocha', 'dark', ['--theme', 'light']), /#8c8fa1/);
    assert.match(run('', ''), /#908caa/);
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents/test.json'), JSON.stringify({
      agentId: 'test', sessionName: 'demo', status: 'working', phase: 'thinking',
      updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(),
    }));
    const styled = run('catppuccin', 'mocha', '', ['--no-source']);
    assert.match(styled, /#\[fg=#89b4fa\]●#\[fg=default\] #\[fg=#cdd6f4\]demo#\[fg=default\]/);
    assert.doesNotMatch(styled, /bg=/);
    assert.match(styled, /#\[fg=#7f849c\] thinking/);
    assert.doesNotMatch(styled, /π/);
    assert.match(run('catppuccin', 'mocha', '', ['--no-source', '--plain']), /^● demo thinking \d\d:\d\d\n$/);
    writeFileSync(join(root, 'agents/second.json'), JSON.stringify({
      agentId: 'second', sessionName: 'other', status: 'idle', updatedAt: new Date().toISOString(),
    }));
    const multiple = run('catppuccin', 'mocha', '', ['--no-source']);
    assert.match(multiple, /  #\[fg=#6c7086\]│#\[fg=default\]  /);
    assert.doesNotMatch(multiple, /bg=/);
    assert.match(run('catppuccin', 'mocha', '', ['--plain']), /  \|  /);
    assert.doesNotMatch(run('catppuccin', 'mocha', '', ['--plain']), /#\[/);
    writeFileSync(join(root, 'config.json'), JSON.stringify({ statusline: { theme: 'light', colors: { dim: '#123456' } } }));
    assert.match(run('catppuccin', 'mocha'), /#123456/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
