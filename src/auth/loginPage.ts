/**
 * Minimal server-rendered login page for the single-owner authorization
 * flow. No client-side dependencies; the pending authorization id binds the
 * form post back to the OAuth request that triggered it.
 */
import {AuthRoutePath} from '../constants.js';

/** Form field names shared between the login page and the login handler. */
export enum LoginField {
  PendingId = 'pending_id',
  Password = 'password',
}

export interface LoginPageOptions {
  pendingId: string;
  clientName?: string;
  errorMessage?: string;
}

function escapeHtml(value: string): string {
  return value
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll('\'', '&#39;');
}

export function renderLoginPage(options: LoginPageOptions): string {
  const client = options.clientName !== undefined ? escapeHtml(options.clientName) : 'An MCP client';
  const error = options.errorMessage !== undefined ?
      `<p class="error">${escapeHtml(options.errorMessage)}</p>` :
      '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Garmin Connect MCP — Sign in</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto; padding: 0 1rem; color: #222; }
    h1 { font-size: 1.25rem; }
    .error { color: #b00020; }
    label { display: block; margin: 1rem 0 0.25rem; }
    input[type=password] { width: 100%; padding: 0.5rem; font-size: 1rem; }
    button { margin-top: 1rem; padding: 0.5rem 1.5rem; font-size: 1rem; }
  </style>
</head>
<body>
  <h1>Garmin Connect MCP</h1>
  <p>${client} is requesting access to this server. Enter the owner password to approve.</p>
  ${error}
  <form method="post" action="${AuthRoutePath.Login}">
    <input type="hidden" name="${LoginField.PendingId}" value="${escapeHtml(options.pendingId)}">
    <label for="${LoginField.Password}">Owner password</label>
    <input type="password" id="${LoginField.Password}" name="${LoginField.Password}" autocomplete="current-password" autofocus required>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}

export function renderErrorPage(message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Garmin Connect MCP — Error</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 24rem; margin: 4rem auto;">
  <h1>Authorization error</h1>
  <p>${escapeHtml(message)}</p>
</body>
</html>`;
}
