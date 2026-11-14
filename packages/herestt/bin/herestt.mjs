#!/usr/bin/env node
// Placeholder that keeps the short name. It installs nothing and makes no network calls.
process.stderr.write(
  'The Here\'s the Thing installer is the "heresthething" package.\n' +
  'Run the exact command shown in the extension ("Connect to agent"), for example:\n' +
  '  npx heresthething@<version>\n',
);
process.exitCode = 1;
