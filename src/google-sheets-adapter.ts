/**
 * Thin wrapper over `googleapis` for the read-only sheets surface this
 * agent needs: DwD credential loading + `spreadsheets.values.get`.
 *
 * No business logic — the boot self-check (`boot-check.ts`) and the
 * sync runner (sub-item 3) call into these methods. Keeping the
 * googleapis surface area corralled here is the AP-3 mitigation: every
 * Google identifier (scope strings, sheet ids, impersonation subjects)
 * crosses exactly one typed boundary.
 *
 * Auth model: Workspace Domain-Wide Delegation per
 * `feedback_workspace_dwd_over_per_user_oauth`. The same service-account
 * key the comms-adviser + calendar-adviser already use
 * (`/etc/ai-comms-adviser/dwd-key.json` or a 0600 copy under this
 * agent's etc dir) impersonates a Workspace user via the `subject`
 * claim. Default subject: `kelvin@liao.info`.
 *
 * Scope: strictly `https://www.googleapis.com/auth/spreadsheets.readonly`.
 * Adding this scope to the existing DwD client_id `101397011922329106102`
 * is a one-time Admin Console edit — handled out-of-band before the
 * agent's first deploy.
 */

import { readFileSync } from 'node:fs';

import { JWT } from 'google-auth-library';
import { google, type sheets_v4 } from 'googleapis';

export const SPREADSHEETS_READONLY_SCOPE =
  'https://www.googleapis.com/auth/spreadsheets.readonly';

/**
 * The W&L Log spreadsheet id — canonical staff working/leave roster.
 * Per memory `reference_wl_log_sheet`. Overridable via env for tests.
 */
export const WL_LOG_DEFAULT_SHEET_ID = '1nxa9K_B5iGj9EAfpSuSo48IHlQEIgW9MRDvMgdbzXqU';

/** Shape of the Workspace DwD service-account JSON key file. */
export interface DwdKeyFile {
  readonly type: string;
  readonly client_email: string;
  readonly private_key: string;
  readonly token_uri: string;
}

export interface GoogleSheetsAdapterDeps {
  /** Path to the DwD service-account key JSON. Defaults to `$DWD_KEY_PATH`. */
  readonly keyFilePath?: string;
  /** Workspace user to impersonate. Defaults to `$DWD_IMPERSONATE_SUBJECT`. */
  readonly subject?: string;
  /** Pre-built sheets client (test seam — production callers omit). */
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

export class GoogleSheetsAdapter {
  readonly #client: sheets_v4.Sheets;

  constructor(client: sheets_v4.Sheets) {
    this.#client = client;
  }

  /**
   * Build an adapter from a DwD service-account key file path + impersonation
   * subject. Fails loud (throws) if either is unset or the key file is empty —
   * the boot self-check catches and renders the AP-4 ranked-cause diagnostic.
   */
  static fromCredentialsFile(deps: GoogleSheetsAdapterDeps = {}): GoogleSheetsAdapter {
    if (deps.client) {
      return new GoogleSheetsAdapter(deps.client);
    }
    const path = deps.keyFilePath ?? process.env.DWD_KEY_PATH;
    if (!path) {
      throw new Error(
        'DWD_KEY_PATH unset and no client provided; cannot load service-account key',
      );
    }
    const subject = deps.subject ?? process.env.DWD_IMPERSONATE_SUBJECT;
    if (!subject) {
      throw new Error(
        'DWD_IMPERSONATE_SUBJECT unset and no subject provided; cannot select impersonation target',
      );
    }
    const raw = readFileSync(path, 'utf-8');
    const key = JSON.parse(raw) as DwdKeyFile;
    for (const k of ['client_email', 'private_key', 'token_uri'] as const) {
      if (!key[k]) {
        throw new Error(`DwD key file at ${path} missing required field: ${k}`);
      }
    }
    const auth = new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [SPREADSHEETS_READONLY_SCOPE],
      subject,
    });
    const client = google.sheets({ version: 'v4', auth });
    return new GoogleSheetsAdapter(client);
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
