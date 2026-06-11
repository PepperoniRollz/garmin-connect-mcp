/**
 * Redirect URI allowlist enforcement (both at client registration and at
 * authorization time): Claude's hosted callbacks exactly, plus RFC 8252
 * loopback redirects with port-agnostic matching for Claude Code.
 */
import {ALLOWED_REDIRECTS} from '../constants.js';

export function isAllowedRedirectUri(uri: string): boolean {
  if ((ALLOWED_REDIRECTS.exact as readonly string[]).includes(uri)) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  // RFC 8252 §7.3: loopback redirects may use any port (and, here, any
  // path — they only ever reach the user's own machine).
  return (
    url.protocol === ALLOWED_REDIRECTS.loopbackProtocol &&
    (ALLOWED_REDIRECTS.loopbackHosts as readonly string[]).includes(
      url.hostname,
    )
  );
}
