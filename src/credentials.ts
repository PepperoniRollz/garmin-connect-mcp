/**
 * Garmin Connect credential resolution. Env vars take precedence; otherwise
 * the OS credential store (macOS Keychain, Windows Credential Manager, or
 * Linux libsecret) is consulted.
 */
import {execFile} from 'child_process';
import {promisify} from 'util';

import {CREDENTIAL_SERVICE, EnvVar} from './constants.js';

const execFileAsync = promisify(execFile);

export interface GarminCredentials {
  username: string;
  password: string;
}

async function getCredentialFromOS(account: string): Promise<string> {
  const platform = process.platform;

  if (platform === 'darwin') {
    // macOS Keychain
    const {stdout} = await execFileAsync('security', [
      'find-generic-password',
      '-s', CREDENTIAL_SERVICE,
      '-a', account,
      '-w',
    ]);
    return stdout.trim();
  }

  if (platform === 'win32') {
    // Windows Credential Manager via PowerShell
    // Use -encodedCommand to avoid injection via string interpolation
    const target = `${CREDENTIAL_SERVICE}/${account}`;
    const script = `(Get-StoredCredential -Target '${target.replace(/'/g, "''")}').GetNetworkCredential().Password`;
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const {stdout} = await execFileAsync('powershell', [
      '-NoProfile', '-EncodedCommand', encoded,
    ]);
    const result = stdout.trim();
    if (!result) throw new Error(`No credential found for target: ${target}`);
    return result;
  }

  if (platform === 'linux') {
    // Linux libsecret (GNOME Keyring / KDE Wallet via secret-tool)
    const {stdout} = await execFileAsync('secret-tool', [
      'lookup', 'service', CREDENTIAL_SERVICE, 'account', account,
    ]);
    return stdout.trim();
  }

  throw new Error(
      `Unsupported platform: ${platform}. Use ${EnvVar.GarminUsername} and ${EnvVar.GarminPassword} env vars instead.`);
}

function getCredentialHelpText(): string {
  const platform = process.platform;

  if (platform === 'darwin') {
    return (
      'Store credentials in macOS Keychain:\n' +
      `  security add-generic-password -s "${CREDENTIAL_SERVICE}" -a "username" -w "your-email"\n` +
      `  security add-generic-password -s "${CREDENTIAL_SERVICE}" -a "password" -w "your-password"`
    );
  }

  if (platform === 'win32') {
    return (
      'Store credentials in Windows Credential Manager (PowerShell):\n' +
      `  New-StoredCredential -Target '${CREDENTIAL_SERVICE}/username' -UserName 'username' -Password 'your-email' -Persist LocalMachine\n` +
      `  New-StoredCredential -Target '${CREDENTIAL_SERVICE}/password' -UserName 'password' -Password 'your-password' -Persist LocalMachine\n` +
      '  (Requires the CredentialManager module: Install-Module -Name CredentialManager)'
    );
  }

  if (platform === 'linux') {
    return (
      'Store credentials using secret-tool (libsecret):\n' +
      `  echo -n 'your-email' | secret-tool store --label='Garmin Username' service ${CREDENTIAL_SERVICE} account username\n` +
      `  echo -n 'your-password' | secret-tool store --label='Garmin Password' service ${CREDENTIAL_SERVICE} account password`
    );
  }

  return `Set ${EnvVar.GarminUsername} and ${EnvVar.GarminPassword} environment variables.`;
}

export async function getCredentials(): Promise<GarminCredentials> {
  // Prefer env vars if set (for CI or manual override)
  const envUsername = process.env[EnvVar.GarminUsername];
  const envPassword = process.env[EnvVar.GarminPassword];
  if (envUsername && envPassword) {
    return {username: envUsername, password: envPassword};
  }

  // Otherwise read from OS credential store
  try {
    const [username, password] = await Promise.all([
      getCredentialFromOS('username'),
      getCredentialFromOS('password'),
    ]);
    return {username, password};
  } catch {
    throw new Error(
        'Garmin credentials not found. ' + getCredentialHelpText() +
        `\n\nOr set ${EnvVar.GarminUsername} and ${EnvVar.GarminPassword} environment variables.`);
  }
}
