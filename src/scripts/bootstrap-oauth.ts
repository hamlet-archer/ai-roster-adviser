/**
 * One-time per-user OAuth consent bootstrap (G6.15b).
 *
 * Runs locally on Kelvin's mac. ai@liao.info clicks through Google's
 * consent screen in the browser; the script captures the redirect on a
 * local HTTP listener, exchanges the authorization code for a refresh
 * token, and writes a token file in the shape
 * `GoogleSheetsUserOauthAdapter`
 * (`src/google-sheets-user-oauth-adapter.ts`) expects.
 *
 * Output file shape (written verbatim, mode 0600):
 *
 *   {
 *     "client_id":        "<google-oauth-client-id>",
 *     "client_secret":    "<google-oauth-client-secret>",
 *     "refresh_token":    "<long-lived refresh token>",
 *     "token_uri":        "https://oauth2.googleapis.com/token",
 *     "allowed_scopes":   ["https://www.googleapis.com/auth/spreadsheets.readonly"],
 *     "granted_at":       "<ISO timestamp>",
 *     "granted_subject":  "ai@liao.info"
 *   }
 *
 * Single subject (`ai@liao.info`) — roster-adviser does NOT need a
 * per-staff token map; ai@ is the only authorized identity per
 * `feedback_no_kelvin_account_impersonation`. The script refuses
 * `--subject=kelvin@liao.info` defensively, mirroring the adapter's
 * `FORBIDDEN_SUBJECTS` guard.
 *
 * Usage (run on Kelvin's mac, NOT the VPS):
 *
 *   export GOOGLE_OAUTH_CLIENT_ID="<from Google Cloud OAuth client>"
 *   export GOOGLE_OAUTH_CLIENT_SECRET="<from Google Cloud OAuth client>"
 *
 *   npx -y tsx src/scripts/bootstrap-oauth.ts
 *
 *   # --force overwrites an existing token file (rarely the right move:
 *   # refresh tokens are sticky and re-running invalidates the prior one).
 *
 * Then scp the resulting file to golden-ai-ops at
 *   /etc/ai-roster-adviser/oauth-token.json (mode 0600, owner ai-roster-adviser).
 *
 * Client reuse: G6.15a's parent row says "Reuses the existing per-user
 * OAuth client (`951896555491-88slv13200i...` from §G2)". Spreadsheets
 * scope needs adding to that client's consent screen in Google Cloud
 * Console before this script will succeed. That is a Kelvin-only browser
 * step; the script itself does not provision the client.
 *
 * No service-account impersonation anywhere. The refresh token is bound
 * by Google to ai@liao.info; impersonating Kelvin is not possible at the
 * token-exchange layer.
 */

import { exec } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { writeFile, access, mkdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';

const DEFAULT_SUBJECT = 'ai@liao.info';
const SPREADSHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const FORBIDDEN_SUBJECTS = Object.freeze(['kelvin@liao.info'] as const);

const SCOPE_ALIAS: Readonly<Record<string, string>> = Object.freeze({
  'spreadsheets.readonly': SPREADSHEETS_READONLY_SCOPE,
});

interface Args {
  subject: string;
  scopes: readonly string[];
  port: number;
  force: boolean;
  outDir: string;
  outFile: string;
}

function parseArgs(argv: readonly string[]): Args {
  const map = new Map<string, string | true>();
  for (const tok of argv) {
    if (!tok.startsWith('--')) continue;
    const eq = tok.indexOf('=');
    if (eq === -1) map.set(tok.slice(2), true);
    else map.set(tok.slice(2, eq), tok.slice(eq + 1));
  }

  const subjectRaw = map.get('subject');
  const subject =
    typeof subjectRaw === 'string' ? subjectRaw.trim() : DEFAULT_SUBJECT;
  if ((FORBIDDEN_SUBJECTS as readonly string[]).includes(subject)) {
    throw new Error(
      `--subject=${subject} is forbidden: per feedback_no_kelvin_account_impersonation, ` +
        `no service may impersonate Kelvin's account`,
    );
  }
  if (!subject) {
    throw new Error('--subject must not be empty');
  }

  const scopesRaw = map.get('scopes');
  const scopes =
    typeof scopesRaw === 'string'
      ? scopesRaw.split(',').map((s) => s.trim()).filter(Boolean)
      : ['spreadsheets.readonly'];
  const resolvedScopes = scopes.map((s) => SCOPE_ALIAS[s] ?? s);
  if (!resolvedScopes.includes(SPREADSHEETS_READONLY_SCOPE)) {
    throw new Error(
      `--scopes must include spreadsheets.readonly (got ${resolvedScopes.join(',')}); ` +
        `the adapter rejects token files whose allowed_scopes lacks it`,
    );
  }

  const portRaw = map.get('port');
  const port =
    typeof portRaw === 'string' ? Number.parseInt(portRaw, 10) || 0 : 8754;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`--port must be an integer in [1024, 65535]; got ${portRaw}`);
  }

  const outDirRaw = map.get('out-dir');
  const outDir =
    typeof outDirRaw === 'string' ? outDirRaw : './oauth-token';
  const outDirAbs = isAbsolute(outDir) ? outDir : resolve(process.cwd(), outDir);

  const outFileRaw = map.get('out-file');
  const outFile =
    typeof outFileRaw === 'string' ? outFileRaw : 'oauth-token.json';

  const force = map.get('force') === true;

  return {
    subject,
    scopes: Object.freeze(resolvedScopes),
    port,
    force,
    outDir: outDirAbs,
    outFile,
  };
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

interface AuthResult {
  code: string;
}

async function awaitAuthCode(port: number, expectedState: string): Promise<AuthResult> {
  return new Promise<AuthResult>((resolveFn, rejectFn) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) {
        res.writeHead(400).end('missing url');
        return;
      }
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const error = u.searchParams.get('error');
      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`OAuth error: ${error}`);
        server.close();
        rejectFn(new Error(`google_consent_returned_error error=${error}`));
        return;
      }
      if (!code || state !== expectedState) {
        res
          .writeHead(400, { 'Content-Type': 'text/plain' })
          .end('bad request: missing code or state mismatch');
        server.close();
        rejectFn(new Error('google_consent_bad_response: missing code or state mismatch'));
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<html><body><h1>OAuth complete — you can close this tab.</h1></body></html>');
      server.close();
      resolveFn({ code });
    });
    server.on('error', rejectFn);
    server.listen(port, '127.0.0.1');
  });
}

function openBrowser(url: string): void {
  // macOS-first; covers Kelvin's daily-driver. Falls back to printing
  // the URL if `open` is unavailable.
  const cmd =
    process.platform === 'darwin'
      ? `open ${JSON.stringify(url)}`
      : `xdg-open ${JSON.stringify(url)}`;
  exec(cmd, (err) => {
    if (err) {
      process.stderr.write(
        `(failed to open browser automatically — open manually: ${url}\n`,
      );
    }
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

interface ExchangeResult {
  refresh_token: string;
  access_token: string;
  scope?: string;
  expires_in?: number;
}

async function exchangeCodeForRefreshToken(
  code: string,
  codeVerifier: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  tokenUri: string,
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const resp = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `bootstrap_oauth_code_exchange_failed status=${resp.status} body=${text.slice(0, 500)}`,
    );
  }
  const json = (await resp.json()) as Partial<ExchangeResult>;
  if (!json.refresh_token) {
    throw new Error(
      `bootstrap_oauth_no_refresh_token: Google did not return one. Re-run with the user revoking access at ` +
        `https://myaccount.google.com/permissions, then consenting again. (Refresh tokens are only issued on first consent unless prompt=consent forces it.)`,
    );
  }
  return {
    refresh_token: json.refresh_token,
    access_token: json.access_token ?? '',
    scope: json.scope,
    expires_in: json.expires_in,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set in env. ' +
        'Reuse the existing §G2 client (951896555491-88slv13200i...) by exporting its ' +
        'client_id + client_secret. Spreadsheets.readonly must be added to that client\'s ' +
        'consent screen in Google Cloud Console before this script will succeed.',
    );
  }

  const outPath = resolve(args.outDir, args.outFile);
  if (!args.force && (await fileExists(outPath))) {
    throw new Error(
      `refusing to overwrite ${outPath} without --force (refresh tokens are sticky; re-running this is rarely what you want)`,
    );
  }

  await mkdir(dirname(outPath), { recursive: true });

  const redirectUri = `http://127.0.0.1:${args.port}/callback`;
  const state = randomBytes(16).toString('base64url');
  const { codeVerifier, codeChallenge } = generatePkce();

  const authParams = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: args.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent', // force-issue a refresh_token even on re-consent
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    login_hint: args.subject,
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${authParams.toString()}`;

  process.stdout.write(
    `\nBootstrapping per-user OAuth for subject=${args.subject}.\n` +
      `Scopes: ${args.scopes.join(' ')}\n` +
      `Listening at ${redirectUri} for the consent redirect...\n\n` +
      `If the browser does not open automatically, open this URL:\n${authUrl}\n\n`,
  );

  openBrowser(authUrl);
  const authResult = await awaitAuthCode(args.port, state);

  const tokenUri = 'https://oauth2.googleapis.com/token';
  const exchange = await exchangeCodeForRefreshToken(
    authResult.code,
    codeVerifier,
    clientId,
    clientSecret,
    redirectUri,
    tokenUri,
  );

  const fileBody = {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: exchange.refresh_token,
    token_uri: tokenUri,
    allowed_scopes: args.scopes,
    granted_at: new Date().toISOString(),
    granted_subject: args.subject,
  };
  await writeFile(outPath, JSON.stringify(fileBody, null, 2), { mode: 0o600 });

  process.stdout.write(
    `\nWrote ${outPath} (mode 0600).\n` +
      `Next: scp this file to golden-ai-ops at /etc/ai-roster-adviser/oauth-token.json ` +
      `(mode 0600, owner ai-roster-adviser).\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
