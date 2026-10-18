// Runs the extension inside a real VS Code: `node test/e2e/run.js` (needs a display, e.g. xvfb-run).
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

runTests({
  extensionDevelopmentPath: path.resolve(__dirname, '../..'),
  extensionTestsPath: path.resolve(__dirname, 'suite.js'),
  launchArgs: [path.resolve(__dirname, 'workspace'), '--disable-extensions', '--disable-workspace-trust'],
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
