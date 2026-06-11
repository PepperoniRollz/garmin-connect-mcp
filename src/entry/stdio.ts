/**
 * Stdio entry point: the original transport, used when the server is spawned
 * as a subprocess by Claude Code / Claude Desktop.
 */
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';

import {AppConfig} from '../config.js';
import {TransportMode} from '../constants.js';
import {createCredentialProvider} from '../credentials.js';
import {configureGarminClient} from '../garminClient.js';
import {logger} from '../logger.js';
import {createServer} from '../server.js';

export async function runStdio(config: AppConfig): Promise<void> {
  configureGarminClient({
    credentialProvider: createCredentialProvider(TransportMode.Stdio),
    tokenCacheDir: config.tokenCacheDir,
  });
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.debug('stdio transport connected');
}
