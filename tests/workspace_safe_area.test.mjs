import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../web/workspace.css', import.meta.url), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test('workspace surfaces define a measured status-bar clearance', () => {
  assert.match(
    css,
    /:root\s*\{[^}]*--workspace-safe-top\s*:\s*max\(env\(safe-area-inset-top,\s*0px\),\s*30px\)\s*;/,
  );
});

test('workspace drawer starts below the status-bar touch area', () => {
  assert.match(ruleBody('.workspace-drawer'), /\btop\s*:\s*var\(--workspace-safe-top\)\s*;/);
});

test('workspace preview starts below the status-bar touch area', () => {
  assert.match(ruleBody('.workspace-preview-modal'), /\binset\s*:\s*var\(--workspace-safe-top\)\s+0\s+0\s*;/);
});
