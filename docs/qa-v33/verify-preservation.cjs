const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const baseline = '6cb3667e8';
const root = 'deploy/yeutech-agent-isolated/web/src/';
const changed = cp.execFileSync('git', ['diff', '--name-only', baseline], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const untracked = cp.execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const allowed = ['App.jsx', 'styles.css', 'workbench-header.jsx', 'workbench-sidebar.jsx', 'styles/workspace-v33.css'].map(file => root + file);
for (const file of [...changed, ...untracked]) {
  assert.ok(allowed.includes(file) || file.startsWith('docs/qa-v33/'), 'Out-of-scope change: ' + file);
  if (!fs.existsSync(file) || !/\.(js|jsx|css|mjs|cjs)$/.test(file)) continue;
  assert.ok(fs.readFileSync(file, 'utf8').split('\n').length <= 600, 'Over 600 lines: ' + file);
}
const files = ['api.js', 'attachment-state.js', 'markdown-parser.js', 'message-projection.js', 'message-scroll.js', 'project-file-reference.js', 'session-ordering.js', 'portal-appearance.js', 'workbench-bootstrap.js', 'use-projection-events.js', 'workbench-actions.js', 'workbench-conversation.jsx', 'workbench-dialogs.jsx', 'workbench-files.jsx', 'workbench-timeline.jsx'];
const preservation = files.map(file => {
  const actual = fs.readFileSync(root + file);
  assert.ok(actual.equals(cp.execFileSync('git', ['show', baseline + ':' + root + file])), file + ' changed');
  return { file, byteIdenticalToV32: true, sha256: crypto.createHash('sha256').update(actual).digest('hex') };
});
const canonical = '/Users/fangjialiang/Documents/家庭网络中枢项目/01_应用项目/家庭网络/yeutech-home-platform/frontend/design/';
const contracts = ['yeutech-material-contract.css', 'yeutech-material-contract.mjs', 'yeutech-material-contract.d.mts'].map(file => {
  const actual = fs.readFileSync(root + 'design/' + file);
  assert.ok(actual.equals(fs.readFileSync(canonical + file)), 'Contract drift: ' + file);
  return { file, canonicalByteIdentical: true, sha256: crypto.createHash('sha256').update(actual).digest('hex') };
});
const tests = cp.execFileSync('git', ['ls-tree', '-r', '--name-only', baseline, 'deploy/yeutech-agent-isolated'], { encoding: 'utf8' }).trim().split('\n').filter(file => /(?:test|spec)\.(?:mjs|js|cjs)$/.test(file));
for (const file of tests) assert.ok(fs.readFileSync(file).equals(cp.execFileSync('git', ['show', baseline + ':' + file])), 'Original test changed: ' + file);
fs.writeFileSync(__dirname + '/scope-verification.json', JSON.stringify({ baseline, modifiedSource: allowed, changed, preservation, contracts, originalTestFilesByteIdentical: tests.length, modifiedCodeFilesUnder600Lines: true }, null, 2) + '\n');
console.log('PASS visual-only scope; ' + preservation.length + ' business modules and ' + tests.length + ' original test files byte-identical; canonical contract SHA verified');
