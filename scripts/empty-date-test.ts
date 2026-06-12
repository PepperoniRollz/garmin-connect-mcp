/**
 * Live acceptance: wellness tools degrade gracefully on dates with NO data
 * (pre-account past and future dates) — clean null-filled results, never an
 * error. Requires real Garmin credentials (OS credential store or env
 * vars); run manually, not part of `npm test`.
 *
 *   npx tsx scripts/empty-date-test.ts
 */
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const EMPTY_DATES = ['2019-01-01', '2099-01-01'];

let failures = 0;
function check(name: string, ok: boolean, detail?: string): void {
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? ` — ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
});
const client = new Client({name: 'empty-date-test', version: '0.0.0'});
await client.connect(transport);

for (const date of EMPTY_DATES) {
  const summary = await client.callTool({
    name: 'get-daily-summary',
    arguments: {date},
  });
  const summaryText = (summary.content as {text: string}[])[0].text;
  const summaryBody = JSON.parse(summaryText) as Record<string, unknown>;
  check(
    `get-daily-summary(${date}) returns non-error result`,
    summary.isError !== true,
  );
  check(
    `get-daily-summary(${date}) null totals, no fabricated values`,
    summaryBody['totalKilocalories'] === null &&
      summaryBody['consumedKilocalories'] === null,
  );

  const sleep = await client.callTool({name: 'get-sleep', arguments: {date}});
  const sleepBody = JSON.parse((sleep.content as {text: string}[])[0].text) as {
    sleepTimeSeconds: unknown;
    stages: Record<string, unknown>;
  };
  check(`get-sleep(${date}) returns non-error result`, sleep.isError !== true);
  check(
    `get-sleep(${date}) null duration and stages`,
    sleepBody.sleepTimeSeconds === null &&
      sleepBody.stages['deepSleepSeconds'] === null,
  );
}

await client.close();
console.log(
  failures === 0 ? '\nAll empty-date checks passed' : `\n${failures} failed`,
);
process.exit(failures === 0 ? 0 : 1);
