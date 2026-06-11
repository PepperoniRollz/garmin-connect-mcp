/**
 * Built-in OAuth 2.1 authorization server provider (single-owner model).
 *
 * The SDK's mcpAuthRouter drives this provider: it validates PKCE (S256
 * only) and client metadata, then delegates storage and the human
 * authorization step here. authorize() renders a password login page; the
 * login route (login.ts) verifies the owner password and issues the code.
 */
import {Response} from 'express';

import {OAuthRegisteredClientsStore} from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {AuthInfo} from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import {AuditEvent, OAUTH} from '../constants.js';
import {logger} from '../logger.js';
import {AuthDb, newOpaqueToken, nowSeconds, TokenKind} from './db.js';
import {renderErrorPage, renderLoginPage} from './loginPage.js';
import {isAllowedRedirectUri} from './redirectUris.js';

const BEARER_TOKEN_TYPE = 'Bearer';

export class OwnerAuthorizationProvider implements OAuthServerProvider {
  constructor(private readonly db: AuthDb) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.db.getClient(clientId),
      registerClient: (client: OAuthClientInformationFull) => {
        const disallowed = client.redirect_uris.filter(
          uri => !isAllowedRedirectUri(uri),
        );
        if (disallowed.length > 0) {
          logger.info('audit', {
            event: AuditEvent.ClientRegistrationRejected,
            redirectUris: disallowed,
          });
          throw new InvalidClientMetadataError(
            `redirect_uris not allowed: ${disallowed.join(', ')} (allowed: claude.ai/claude.com callbacks and RFC 8252 loopback)`,
          );
        }
        this.db.putClient(client);
        logger.info('audit', {
          event: AuditEvent.ClientRegistered,
          clientId: client.client_id,
        });
        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // Defense in depth: the redirect target is re-checked here even though
    // registration already enforced the allowlist. Never redirect to an
    // unvetted URI — render the error instead.
    if (!isAllowedRedirectUri(params.redirectUri)) {
      res
        .status(400)
        .type('html')
        .send(
          renderErrorPage(
            "The redirect URI is not on this server's allowlist.",
          ),
        );
      return;
    }

    const pendingId = newOpaqueToken();
    this.db.createPendingAuthorization({
      id: pendingId,
      clientId: client.client_id,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scopes: params.scopes ?? [],
      state: params.state,
      resource: params.resource?.href,
      expiresAt: nowSeconds() + OAUTH.pendingAuthorizationTtlSeconds,
    });
    res
      .status(200)
      .type('html')
      .send(renderLoginPage({pendingId, clientName: client.client_name}));
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = this.db.getAuthorizationCode(authorizationCode);
    if (record === undefined || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const record = this.db.getAuthorizationCode(authorizationCode);
    if (record === undefined || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError(
        'redirect_uri does not match the authorization request',
      );
    }
    // Single use: burn the code before issuing tokens.
    this.db.deleteAuthorizationCode(authorizationCode);

    const tokens = this.issueTokens(
      client.client_id,
      record.scopes,
      record.resource,
    );
    logger.info('audit', {
      event: AuditEvent.TokenIssued,
      clientId: client.client_id,
    });
    return tokens;
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const record = this.db.getToken(refreshToken, TokenKind.Refresh);
    if (record === undefined || record.clientId !== client.client_id) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    const grantedScopes = record.scopes;
    if (
      scopes !== undefined &&
      scopes.some(scope => !grantedScopes.includes(scope))
    ) {
      throw new InvalidGrantError('Requested scopes exceed the original grant');
    }
    // OAuth 2.1 refresh token rotation: the presented token is consumed.
    this.db.deleteToken(refreshToken);

    const tokens = this.issueTokens(
      client.client_id,
      scopes ?? grantedScopes,
      record.resource,
    );
    logger.info('audit', {
      event: AuditEvent.TokenRefreshed,
      clientId: client.client_id,
    });
    return tokens;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.db.getToken(token, TokenKind.Access);
    if (record === undefined) {
      throw new InvalidTokenError('Invalid or expired access token');
    }
    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource:
        record.resource !== undefined ? new URL(record.resource) : undefined,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const token = request.token;
    const record =
      this.db.getToken(token, TokenKind.Access) ??
      this.db.getToken(token, TokenKind.Refresh);
    if (record === undefined || record.clientId !== client.client_id) {
      return; // Per RFC 7009, revoking an unknown token is a no-op.
    }
    this.db.deleteToken(token);
    logger.info('audit', {
      event: AuditEvent.TokenRevoked,
      clientId: client.client_id,
    });
  }

  /** Used by the login route after the owner password checks out. */
  issueAuthorizationCode(
    pendingId: string,
  ): {code: string; redirectUri: string; state?: string} | undefined {
    const pending = this.db.getPendingAuthorization(pendingId);
    if (pending === undefined) return undefined;
    this.db.deletePendingAuthorization(pendingId);

    const code = newOpaqueToken();
    this.db.createAuthorizationCode(code, {
      clientId: pending.clientId,
      codeChallenge: pending.codeChallenge,
      redirectUri: pending.redirectUri,
      scopes: pending.scopes,
      resource: pending.resource,
      expiresAt: nowSeconds() + OAUTH.authorizationCodeTtlSeconds,
    });
    return {code, redirectUri: pending.redirectUri, state: pending.state};
  }

  private issueTokens(
    clientId: string,
    scopes: string[],
    resource?: string,
  ): OAuthTokens {
    const accessToken = newOpaqueToken();
    const refreshToken = newOpaqueToken();
    const now = nowSeconds();
    this.db.insertToken(accessToken, {
      kind: TokenKind.Access,
      clientId,
      scopes,
      resource,
      expiresAt: now + OAUTH.accessTokenTtlSeconds,
    });
    this.db.insertToken(refreshToken, {
      kind: TokenKind.Refresh,
      clientId,
      scopes,
      resource,
      expiresAt: now + OAUTH.refreshTokenTtlSeconds,
    });
    return {
      access_token: accessToken,
      token_type: BEARER_TOKEN_TYPE,
      expires_in: OAUTH.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.length > 0 ? scopes.join(' ') : undefined,
    };
  }
}
