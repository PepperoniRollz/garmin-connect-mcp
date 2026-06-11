/**
 * HTTP entry point: Streamable HTTP transport on an Express app, intended to
 * sit behind a TLS-terminating reverse proxy. Binds to loopback only.
 *
 * Session lifecycle per the MCP Streamable HTTP spec:
 * - POST initialize (no session header) creates a transport; the SDK issues
 *   an `Mcp-Session-Id` header on the response.
 * - Subsequent POST/GET requests carry the header and are routed to the
 *   session's transport (GET opens the standalone SSE stream).
 * - DELETE tears the session down.
 */
import {randomUUID} from 'node:crypto';

import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import express, {Request, Response} from 'express';

import {AppConfig} from '../config.js';
import {
  DEFAULTS,
  HeaderName,
  JSON_RPC_VERSION,
  JsonRpcErrorCode,
  RoutePath,
  TransportMode,
} from '../constants.js';
import {createCredentialProvider} from '../credentials.js';
import {configureGarminClient} from '../garminClient.js';
import {logger} from '../logger.js';
import {createServer} from '../server.js';

function jsonRpcError(res: Response, status: number, code: JsonRpcErrorCode, message: string): void {
  res.status(status).json({
    jsonrpc: JSON_RPC_VERSION,
    error: {code, message},
    id: null,
  });
}

function getSessionId(req: Request): string | undefined {
  const value = req.headers[HeaderName.McpSessionId];
  return Array.isArray(value) ? value[0] : value;
}

export async function runHttp(config: AppConfig): Promise<void> {
  configureGarminClient({
    credentialProvider: createCredentialProvider(TransportMode.Http),
    tokenCacheDir: config.tokenCacheDir,
  });
  const {port} = config;
  const app = express();
  app.use(express.json());

  /** Active transports keyed by session id. */
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(RoutePath.Mcp, async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);

    let transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      if (sessionId !== undefined) {
        jsonRpcError(res, 404, JsonRpcErrorCode.SessionNotFound, 'Session not found');
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(
            res, 400, JsonRpcErrorCode.InvalidRequest,
            'Bad request: no session ID and not an initialize request');
        return;
      }

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, newTransport);
          logger.info('mcp session initialized', {sessionId: sid});
        },
        onsessionclosed: (sid) => {
          transports.delete(sid);
          logger.info('mcp session closed', {sessionId: sid});
        },
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId !== undefined) {
          transports.delete(newTransport.sessionId);
        }
      };

      const server = createServer();
      await server.connect(newTransport);
      transport = newTransport;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);
    const transport = sessionId !== undefined ? transports.get(sessionId) : undefined;
    if (transport === undefined) {
      jsonRpcError(res, 404, JsonRpcErrorCode.SessionNotFound, 'Session not found');
      return;
    }
    await transport.handleRequest(req, res);
  };

  // GET opens the standalone SSE stream; DELETE terminates the session.
  app.get(RoutePath.Mcp, handleSessionRequest);
  app.delete(RoutePath.Mcp, handleSessionRequest);

  app.listen(port, DEFAULTS.host, () => {
    logger.info('http transport listening', {
      host: DEFAULTS.host,
      port,
      path: RoutePath.Mcp,
    });
  });
}
