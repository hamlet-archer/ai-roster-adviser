/**
 * Google Sheets per-user OAuth adapter for roster-adviser (G6.15a).
 *
 * Holds a SINGLE OAuth refresh token bound to `ai@liao.info` (the system's
 * own identity, the only authorized subject for the W&L sheet read) —
 * never a human staff member's mailbox, and never Kelvin's. Per
 * `feedback_no_kelvin_account_impersonation` the module rejects
 * `subject=kelvin@liao.info` at load time. Per `feedback_no_dwd_anywhere`
 * this adapter replaces the DwD-via-JWT shape that authenticated as
 * `kelvin@liao.info` workspace-wide (deleted DwD client `101397011922329106102`,
 * 2026-05-14).
 *
 * Token-file shape, written by `scripts/bootstrap-oauth.ts` (G6.15b) to
 * `/etc/ai-roster-adviser/oauth-token.json` (mode 0600). Same shape as
 * ai-calendar-adviser's `google-calendar-user-oauth-adapter.ts` (G6.5a)
 * and ai-comms-adviser's per-staff Gmail token files:
 *
 *   {
 *     "client_id": "<google-oauth-client-id>",
 *     "client_secret": "<google-oauth-client-secret>",
 *     "refresh_token": "<long-lived refresh token>",
 *     "token_uri": "https://oauth2.googleapis.com/token",
 *     "allowed_scopes": [
 *       "https://www.googleapis.com/auth/spreadsheets.readonly"
 *     ]
 *   }
 *
 * Internally the googleapis Sheets client is wired with an `OAuth2Client`
 * that auto-refreshes via the refresh token; `exchangeRefreshToken()` is
 * also exposed for tests + auditing the refresh path with a mocked token
 * endpoint.
 *
 * Missing-token-file behavior: throws synchronously. The adapter is the
 * only auth path; absent the token, the roster surface is offline.
 *
 * Historical context (2026-05-13 security cut, G6.15a/b/c): this adapter
 * replaced a service-account-impersonation shape that authenticated as
 * `kelvin@liao.info` workspace-wide. See `feedback_no_dwd_anywhere` +
 * `feedback_no_kelvin_account_impersonation` for the rationale.
 */

import { readFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { google, type sheets_v4 } from 'googleapis';

export const SPREADSHEETS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets.readonly';

export const OAUTH_TOKEN_PATH_DEFAULT = '/etc/ai-roster-adviser/oauth-token.json';
export const OAUTH_SUBJECT_DEFAULT = 'ai@liao.info';

/**
 * Subjects this adapter refuses to authenticate as. The single member today
 * is `kelvin@liao.info` — per `feedback_no_kelvin_account_impersonation`,
 * no service-side code path may impersonate Kelvin's account. The check is
 * defensive: a misconfigured env or hand-edited token file should fail
 * loud at adapter construction, not silently mint a Kelvin-scoped token.
 */
export const FORBIDDEN_SUBJECTS = Object.freeze(['kelvin@liao.info'] as const);

/**
 * The W&L Log spreadsheet id — canonical staff working/leave roster.
 * Per memory `reference_wl_log_sheet`. Overridable via env for tests.
 */
export const WL_LOG_DEFAULT_SHEET_ID = '1nxa9K_B5iGj9EAfpSuSo48IHlQEIgW9MRDvMgdbzXqU';

/** Shape of the per-user OAuth token file on disk. */
export interface UserOauthTokenFile {
  readonly client_id: string;
  readonly client_secret: string;
  readonly refresh_token: string;
  readonly token_uri: string;
  readonly allowed_scopes: readonly string[];
}

export interface FromTokenFileDeps {
  /** Path to the per-user OAuth token JSON. Defaults to `$OAUTH_TOKEN_PATH`. */
  readonly tokenFilePath?: string;
  /**
   * Subject (Google account email) this adapter authenticates as.
   * Defaults to `$OAUTH_SUBJECT` then `ai@liao.info`. Rejected if it
   * matches `FORBIDDEN_SUBJECTS` (i.e. `kelvin@liao.info`).
   *
   * The subject is metadata: the refresh token is the actual auth, and
   * it is bound to a Google account by the OAuth consent flow. The
   * subject argument exists so the adapter can fail loud if the
   * caller's *intent* (env / config) names a forbidden user, even
   * before a network call happens.
   */
  readonly subject?: string;
  /** Pre-built sheets client (test seam — production callers omit this). */
  readonly client?: sheets_v4.Sheets;
}

export interface ValuesGetOptions {
  readonly spreadsheetId: string;
  /** A1 notation range, e.g. `Roster!A1:ZZ`. */
  readonly range: string;
  /**
   * UNFORMATTED_VALUE preserves raw cell content (numbers, booleans) so the
   * sync runner can compare against `status_value_to_enum_map` deterministically;
   * FORMATTED_VALUE would let Sheets-side number formatting (e.g. "1" → "1.00")
   * leak into the comparison. Default: UNFORMATTED_VALUE.
   */
  readonly valueRenderOption?: 'FORMATTED_VALUE' | 'UNFORMATTED_VALUE' | 'FORMULA';
}

export interface ValuesGetResult {
  /** Two-dimensional grid of cell values. Cell-level types match Sheets API
   *  (string | number | boolean); the sync runner coerces to strings before
   *  matching against the status-value map. */
  readonly values: ReadonlyArray<readonly (string | number | boolean | null)[]>;
}

export class GoogleSheetsUserOauthAdapter {
  readonly #client: sheets_v4.Sheets;

  constructor(client: sheets_v4.Sheets) {
    this.#client = client;
  }

  /**
   * Build an adapter from a per-user OAuth token file on disk. Throws if:
   *   - the resolved subject is forbidden (e.g. `kelvin@liao.info`)
   *   - the resolved subject is empty
   *   - the token file is missing / unparseable / missing required fields
   *   - `allowed_scopes` does not include `spreadsheets.readonly`
   *
   * The boot self-check catches and renders the AP-4 ranked-cause
   * diagnostic.
   */
  static fromTokenFile(deps: FromTokenFileDeps = {}): GoogleSheetsUserOauthAdapter {
    if (deps.client) {
      return new GoogleSheetsUserOauthAdapter(deps.client);
    }

    const subject = (deps.subject ?? process.env.OAUTH_SUBJECT ?? OAUTH_SUBJECT_DEFAULT).trim();
    if (!subject) {
      throw new Error(
        'sheets_user_oauth_subject_unset: pass subject or set OAUTH_SUBJECT',
      );
    }
    if ((FORBIDDEN_SUBJECTS as readonly string[]).includes(subject)) {
      throw new Error(
        `sheets_user_oauth_subject_forbidden subject=${subject}: ` +
          `per feedback_no_kelvin_account_impersonation, ` +
          `no service may impersonate Kelvin's account`,
      );
    }

    const path = deps.tokenFilePath ?? process.env.OAUTH_TOKEN_PATH ?? OAUTH_TOKEN_PATH_DEFAULT;
    const token = loadAndValidateTokenFile(path);
    if (!token.allowed_scopes.includes(SPREADSHEETS_READONLY_SCOPE)) {
      throw new Error(
        `sheets_user_oauth_scope_missing path=${path}: ` +
          `allowed_scopes must include ${SPREADSHEETS_READONLY_SCOPE}`,
      );
    }

    const oauth2 = new OAuth2Client({
      clientId: token.client_id,
      clientSecret: token.client_secret,
    });
    oauth2.setCredentials({ refresh_token: token.refresh_token });
    const client = google.sheets({ version: 'v4', auth: oauth2 });
    return new GoogleSheetsUserOauthAdapter(client);
  }

  /**
   * Fetch a range of cell values.
   *
   * The W&L sheet is small (~12 staff × ~365 days). One values.get call
   * returns the full grid. We don't paginate.
   */
  async valuesGet(options: ValuesGetOptions): Promise<ValuesGetResult> {
    const res = await this.#client.spreadsheets.values.get({
      spreadsheetId: options.spreadsheetId,
      range: options.range,
      valueRenderOption: options.valueRenderOption ?? 'UNFORMATTED_VALUE',
    });
    const values = res.data.values ?? [];
    return { values: values as ReadonlyArray<readonly (string | number | boolean | null)[]> };
  }
}

/**
 * Manual OAuth2 refresh-token exchange — no googleapis dependency.
 *
 * Production calls go through the `OAuth2Client` wired into `fromTokenFile`,
 * which auto-refreshes opaquely. This standalone helper exists so the refresh
 * path is exercisable from a unit test with a mocked `fetch`, mirroring
 * `ai-calendar-adviser`'s `exchangeRefreshToken()` shape (G6.5a) and
 * `ai-comms-adviser`'s `GmailUserOauthAdapter.getAccessToken()` shape.
 *
 * Throws if the token endpoint returns non-2xx.
 */
export async function exchangeRefreshToken(
  token: UserOauthTokenFile,
  scope: string = SPREADSHEETS_READONLY_SCOPE,
): Promise<{ access_token: string; expires_in: number }> {
  if (!token.allowed_scopes.includes(scope)) {
    throw new Error(
      `sheets_user_oauth_scope_denied requested=${scope} ` +
        `allowed=${token.allowed_scopes.join(',')}`,
    );
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: token.refresh_token,
    client_id: token.client_id,
    client_secret: token.client_secret,
    scope,
  });
  const resp = await fetch(token.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `sheets_user_oauth_refresh_failed status=${resp.status} body=${text.slice(0, 300)}`,
    );
  }
  const json = (await resp.json()) as { access_token: string; expires_in: number };
  return json;
}

function loadAndValidateTokenFile(path: string): UserOauthTokenFile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `sheets_user_oauth_token_missing path=${path}: ` +
          `run scripts/bootstrap-oauth.ts to mint a refresh token`,
      );
    }
    throw err;
  }
  let parsed: Partial<UserOauthTokenFile>;
  try {
    parsed = JSON.parse(raw) as Partial<UserOauthTokenFile>;
  } catch (err) {
    throw new Error(
      `sheets_user_oauth_token_unparseable path=${path} err=${(err as Error).message}`,
    );
  }
  if (
    !parsed.client_id ||
    !parsed.client_secret ||
    !parsed.refresh_token ||
    !parsed.token_uri ||
    !Array.isArray(parsed.allowed_scopes) ||
    parsed.allowed_scopes.length === 0
  ) {
    throw new Error(
      `sheets_user_oauth_token_invalid path=${path}: ` +
        `expected client_id/client_secret/refresh_token/token_uri/allowed_scopes`,
    );
  }
  return {
    client_id: parsed.client_id,
    client_secret: parsed.client_secret,
    refresh_token: parsed.refresh_token,
    token_uri: parsed.token_uri,
    allowed_scopes: Object.freeze([...parsed.allowed_scopes]),
  };
}
