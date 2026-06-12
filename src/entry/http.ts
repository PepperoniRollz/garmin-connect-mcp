/**
 * HTTP entry point: Streamable HTTP transport on an Express app protected by
 * the built-in OAuth 2.1 authorization server. Binds to loopback only and
 * expects a TLS-terminating reverse proxy in front.
 *
 * Session lifecycle per the MCP Streamable HTTP spec:
 * - POST initialize (no session header) creates a transport; the SDK issues
 *   an `Mcp-Session-Id` header on the response.
 * - Subsequent POST/GET requests carry the header and are routed to the
 *   session's transport (GET opens the standalone SSE stream).
 * - DELETE tears the session down; abandoned sessions are reaped by the
 *   idle sweep (see SESSION_SWEEP in constants.ts).
 *
 * Every MCP request must carry a valid bearer token; 401 responses carry a
 * WWW-Authenticate header pointing at the protected-resource metadata.
 */
import {randomUUID} from 'node:crypto';

import {requireBearerAuth} from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import express, {NextFunction, Request, Response} from 'express';
import {rateLimit} from 'express-rate-limit';

import {AppConfig, HttpConfig} from '../config.js';
import {
  AuditEvent,
  HeaderName,
  JSON_RPC_VERSION,
  JsonRpcErrorCode,
  OAUTH,
  RATE_LIMIT,
  RoutePath,
  SERVER_INFO,
  SESSION_SWEEP,
  TransportMode,
} from '../constants.js';
import {createCredentialProvider} from '../credentials.js';
import {configureTimezone} from '../clock.js';
import {configureGarminClient} from '../garminClient.js';
import {configureLiftStore} from '../lift/store.js';
import {logger} from '../logger.js';
import {createServer} from '../server.js';
import {AuthDb} from '../auth/db.js';
import {createLoginRouter} from '../auth/login.js';
import {OwnerAuthorizationProvider} from '../auth/provider.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivityMs: number;
}

function jsonRpcError(
  res: Response,
  status: number,
  code: JsonRpcErrorCode,
  message: string,
): void {
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

/** Audits authentication outcomes on the MCP endpoint (401s only). */
function auditUnauthorized(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.on('finish', () => {
    if (res.statusCode === 401) {
      logger.info('audit', {
        event: AuditEvent.McpUnauthorized,
        ip: req.ip,
        method: req.method,
      });
    }
  });
  next();
}

export async function runHttp(config: AppConfig): Promise<void> {
  const httpConfig: HttpConfig | undefined = config.http;
  if (httpConfig === undefined) {
    throw new Error(
      'runHttp called without http config; loadConfig should have failed first',
    );
  }

  configureGarminClient({
    credentialProvider: createCredentialProvider(TransportMode.Http),
    tokenCacheDir: config.tokenCacheDir,
  });
  configureLiftStore(config.liftDbPath);
  configureTimezone(config.liftTimezone);

  const db = new AuthDb(httpConfig.authDbPath);
  const provider = new OwnerAuthorizationProvider(db);
  const issuerUrl = new URL(httpConfig.publicUrl.origin);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    httpConfig.publicUrl,
  );

  const app = express();
  app.set('trust proxy', httpConfig.trustedProxy);
  app.use(express.json());

  // Unauthenticated liveness probe: no data, no auth, no rate limit.
  app.get(RoutePath.Healthz, (_req: Request, res: Response) => {
    res.status(200).json({status: 'ok'});
  });

  // OAuth authorization server: /authorize, /token, /register, /revoke and
  // RFC 8414 + RFC 9728 discovery metadata (SDK applies its own rate limits).
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl,
      resourceServerUrl: httpConfig.publicUrl,
      resourceName: SERVER_INFO.name,
      scopesSupported: [...OAUTH.scopesSupported],
    }),
  );
  app.use(createLoginRouter(provider, httpConfig.serverOwnerPasswordHash));

  const mcpRateLimit = rateLimit({
    windowMs: RATE_LIMIT.mcp.windowMs,
    limit: RATE_LIMIT.mcp.limit,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const bearerAuth = requireBearerAuth({
    verifier: provider,
    resourceMetadataUrl,
  });
  app.use(RoutePath.Mcp, mcpRateLimit, auditUnauthorized, bearerAuth);

  /** Active transports keyed by session id. */
  const sessions = new Map<string, SessionEntry>();

  const touchSession = (sessionId: string): SessionEntry | undefined => {
    const entry = sessions.get(sessionId);
    if (entry !== undefined) {
      entry.lastActivityMs = Date.now();
    }
    return entry;
  };

  app.post(RoutePath.Mcp, async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);

    let entry = sessionId !== undefined ? touchSession(sessionId) : undefined;
    if (entry === undefined) {
      if (sessionId !== undefined) {
        jsonRpcError(
          res,
          404,
          JsonRpcErrorCode.SessionNotFound,
          'Session not found',
        );
        return;
      }
      if (!isInitializeRequest(req.body)) {
        jsonRpcError(
          res,
          400,
          JsonRpcErrorCode.InvalidRequest,
          'Bad request: no session ID and not an initialize request',
        );
        return;
      }

      const newTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: sid => {
          sessions.set(sid, {
            transport: newTransport,
            lastActivityMs: Date.now(),
          });
          logger.info('mcp session initialized', {
            sessionId: sid,
            clientId: req.auth?.clientId,
          });
        },
        onsessionclosed: sid => {
          sessions.delete(sid);
          logger.info('mcp session closed', {sessionId: sid});
        },
      });
      newTransport.onclose = () => {
        if (newTransport.sessionId !== undefined) {
          sessions.delete(newTransport.sessionId);
        }
      };

      const server = createServer();
      await server.connect(newTransport);
      entry = {transport: newTransport, lastActivityMs: Date.now()};
    }

    await entry.transport.handleRequest(req, res, req.body);
  });

  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = getSessionId(req);
    const entry = sessionId !== undefined ? touchSession(sessionId) : undefined;
    if (entry === undefined) {
      jsonRpcError(
        res,
        404,
        JsonRpcErrorCode.SessionNotFound,
        'Session not found',
      );
      return;
    }
    await entry.transport.handleRequest(req, res);
  };

  // GET opens the standalone SSE stream; DELETE terminates the session.
  app.get(RoutePath.Mcp, handleSessionRequest);
  app.delete(RoutePath.Mcp, handleSessionRequest);

  // Idle-session sweep + expired auth row cleanup. Designed with token
  // lifetimes: tokens gate every request, the sweep only reclaims memory
  // from abandoned transports.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - SESSION_SWEEP.idleTimeoutMs;
    for (const [sessionId, entry] of sessions) {
      if (entry.lastActivityMs < cutoff) {
        logger.info('mcp session reaped (idle)', {sessionId});
        sessions.delete(sessionId);
        void entry.transport.close().catch((err: unknown) => {
          logger.warn('error closing idle session', {
            sessionId,
            error: String(err),
          });
        });
      }
    }
    const purged = db.deleteExpired();
    if (purged > 0) {
      logger.debug('expired auth rows purged', {count: purged});
    }
  }, SESSION_SWEEP.sweepIntervalMs);
  sweep.unref();

  app.listen(config.port, httpConfig.bindHost, () => {
    logger.info('http transport listening', {
      host: httpConfig.bindHost,
      port: config.port,
      path: RoutePath.Mcp,
      publicUrl: httpConfig.publicUrl.href,
      authDbPath: httpConfig.authDbPath,
    });
  });
}
