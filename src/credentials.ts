/**
 * Garmin Connect credential resolution behind a CredentialProvider
 * abstraction.
 *
 * - HTTP mode: environment variables only (canonical for remote
 *   deployments; presence is validated at startup by the config module).
 * - Stdio mode: environment variables if set, falling back to the OS
 *   credential store (macOS Keychain, Windows Credential Manager, or Linux
 *   libsecret) for backward compatibility.
 */
import {execFile} from 'child_process';
import {promisify} from 'util';

import {CREDENTIAL_SERVICE, EnvVar, TransportMode} from './constants.js';
import {logger} from './logger.js';

const execFileAsync = promisify(execFile);

export interface GarminCredentials {
  username: string;
  password: string;
}

export interface CredentialProvider {
  /** Human-readable source name used in logs and error messages. */
  readonly source: string;
  getCredentials(): Promise<GarminCredentials>;
}

/** Reads credentials from GARMIN_USERNAME / GARMIN_PASSWORD. */
export class EnvCredentialProvider implements CredentialProvider {
  readonly source = 'environment variables';

  async getCredentials(): Promise<GarminCredentials> {
    const username = process.env[EnvVar.GarminUsername];
    const password = process.env[EnvVar.GarminPassword];
    if (!username || !password) {
      throw new Error(
        `${EnvVar.GarminUsername} and ${EnvVar.GarminPassword} must both be set`,
      );
    }
    return {username, password};
  }
}

/** Reads credentials from the platform credential store. */
export class KeyringCredentialProvider implements CredentialProvider {
  readonly source = 'OS credential store';

  async getCredentials(): Promise<GarminCredentials> {
    try {
      const [username, password] = await Promise.all([
        this.getCredentialFromOS('username'),
        this.getCredentialFromOS('password'),
      ]);
      return {username, password};
    } catch {
      throw new Error(
        `Garmin credentials not found in the ${this.source}. ${keyringHelpText()}`,
      );
    }
  }

  private async getCredentialFromOS(account: string): Promise<string> {
    const platform = process.platform;

    if (platform === 'darwin') {
      // macOS Keychain
      const {stdout} = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        CREDENTIAL_SERVICE,
        '-a',
        account,
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
        '-NoProfile',
        '-EncodedCommand',
        encoded,
      ]);
      const result = stdout.trim();
      if (!result) throw new Error(`No credential found for target: ${target}`);
      return result;
    }

    if (platform === 'linux') {
      // Linux libsecret (GNOME Keyring / KDE Wallet via secret-tool)
      const {stdout} = await execFileAsync('secret-tool', [
        'lookup',
        'service',
        CREDENTIAL_SERVICE,
        'account',
        account,
      ]);
      return stdout.trim();
    }

    throw new Error(
      `Unsupported platform: ${platform}. Use ${EnvVar.GarminUsername} and ${EnvVar.GarminPassword} env vars instead.`,
    );
  }
}

/** Tries each provider in order; fails with the combined error trail. */
export class ChainedCredentialProvider implements CredentialProvider {
  readonly source: string;

  constructor(private readonly providers: readonly CredentialProvider[]) {
    this.source = providers.map(provider => provider.source).join(', then ');
  }

  async getCredentials(): Promise<GarminCredentials> {
    const failures: string[] = [];
    for (const provider of this.providers) {
      try {
        const credentials = await provider.getCredentials();
        logger.debug('credentials resolved', {source: provider.source});
        return credentials;
      } catch (err) {
        failures.push(
          `${provider.source}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    throw new Error(
      `Garmin credentials not found. Tried:\n${failures.map(failure => `  - ${failure}`).join('\n')}`,
    );
  }
}

/** Returns the default provider chain for the given transport mode. */
export function createCredentialProvider(
  mode: TransportMode,
): CredentialProvider {
  if (mode === TransportMode.Http) {
    return new EnvCredentialProvider();
  }
  // Stdio keeps the historical behavior: env vars take precedence when both
  // are set; otherwise the OS credential store is consulted.
  return new ChainedCredentialProvider([
    new EnvCredentialProvider(),
    new KeyringCredentialProvider(),
  ]);
}

function keyringHelpText(): string {
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
