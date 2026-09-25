/**
 * Dev tool: parse a local playlist and print a summary.
 *   npm run parse -w @ziptv/server -- ./my-list.m3u [--json]
 */
import { readFileSync } from 'node:fs';

import { parsePlaylistBytes } from '../modules/m3u/index.js';

const [file, flag] = process.argv.slice(2);
if (!file) {
  console.error('Usage: npm run parse -- <file.m3u> [--json]');
  process.exit(1);
}

const started = performance.now();
const result = parsePlaylistBytes(readFileSync(file));
const elapsed = (performance.now() - started).toFixed(1);

if (flag === '--json') {
  console.log(JSON.stringify(result, null, 2));
} else {
  const groups = new Map<string, number>();
  for (const channel of result.channels) {
    for (const group of channel.groups.length ? channel.groups : ['']) groups.set(group, (groups.get(group) ?? 0) + 1);
  }
  const kinds = new Map<string, number>();
  for (const channel of result.channels) kinds.set(channel.kind, (kinds.get(channel.kind) ?? 0) + 1);

  console.log(`format=${result.format} encoding=${result.encoding} parsed in ${elapsed}ms`);
  console.log(`channels=${result.channels.length} groups=${groups.size} warnings=${result.warningCount}`);
  console.log('kinds:', Object.fromEntries(kinds));
  console.log('groups:', Object.fromEntries(groups));
  console.log('with headers:', result.channels.filter((c) => Object.keys(c.headers).length > 0).length);
  for (const warning of result.warnings.slice(0, 20)) console.log(`  line ${warning.line} [${warning.code}] ${warning.message}`);
  for (const channel of result.channels.slice(0, 5)) {
    console.log(`  ${channel.key} | ${channel.groups.join(';')} | ${channel.name} | ${channel.kind} | ${channel.url.slice(0, 60)}`);
  }
}
