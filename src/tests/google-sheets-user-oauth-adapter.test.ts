/**
 * GoogleSheetsUserOauthAdapter — per-user OAuth refresh-token adapter
 * for ai@liao.info. The new auth path for W&L sheet reads (G6.15a).
 *
 * Covers:
 *   - factory: subject defaults + env override + forbidden-subject rejection
 *   - factory: token file missing / unparseable / invalid / scope missing
 *   - factory: happy path produces a working adapter (via test-seam client)
 *   - valuesGet wires the right options to the underlying sheets client
 *   - exchangeRefreshToken (the manual OAuth2 refresh path): happy path
 *     against a mocked token endpoint, scope-denied rejection,
 *     non-2xx error surface
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { sheets_v4 } from 'googleapis';
import {
  FORBIDDEN_SUBJECTS,
  GoogleSheetsUserOauthAdapter,
  OAUTH_SUBJECT_DEFAULT,
  SPREADSHEETS_READONLY_SCOPE,
  WL_LOG_DEFAULT_SHEET_ID,
  exchangeRefreshToken,
  type UserOauthTokenFile,
  type ValuesGetOptions,
} from '../google-sheets-user-oauth-adapter.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'roster-user-oauth-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeTokenFile(overrides: Partial<UserOauthTokenFile> = {}): string {
  const path = join(tmpDir, 'oauth-token.json');
  writeFileSync(
    path,
    JSON.stringify({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      refresh_token: 'test-refresh-token',
      token_uri: 'https://oauth2.googleapis.com/token',
      allowed_scopes: [SPREADSHEETS_READONLY_SCOPE],
      ...overrides,
    }),
  );
  return path;
}

function mockClient(opts: {
  values?: ReadonlyArray<readonly (string | number | boolean | null)[]>;
  capturedParams?: sheets_v4.Params$Resource$Spreadsheets$Values$Get[];
}): sheets_v4.Sheets {
  const values = {
    get: async (params: sheets_v4.Params$Resource$Spreadsheets$Values$Get) => {
      opts.capturedParams?.push(params);
      return { data: { values: opts.values ?? [] } };
    },
  };
  const spreadsheets = { values };
  return { spreadsheets } as unknown as sheets_v4.Sheets;
}

describe('GoogleSheetsUserOauthAdapter.fromTokenFile — subject discipline', () => {
  it('rejects subject=kelvin@liao.info at load time (no-impersonation policy)', () => {
    const path = writeTokenFile();
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'kelvin@liao.info',
      }),
    ).toThrow(/sheets_user_oauth_subject_forbidden subject=kelvin@liao\.info/);
  });

  it('rejects every entry in FORBIDDEN_SUBJECTS', () => {
    const path = writeTokenFile();
    for (const forbidden of FORBIDDEN_SUBJECTS) {
      expect(() =>
        GoogleSheetsUserOauthAdapter.fromTokenFile({
          tokenFilePath: path,
          subject: forbidden,
        }),
      ).toThrow(/sheets_user_oauth_subject_forbidden/);
    }
  });

  it('rejects subject sourced from OAUTH_SUBJECT env when forbidden', () => {
    const path = writeTokenFile();
    const prev = process.env.OAUTH_SUBJECT;
    process.env.OAUTH_SUBJECT = 'kelvin@liao.info';
    try {
      expect(() =>
        GoogleSheetsUserOauthAdapter.fromTokenFile({ tokenFilePath: path }),
      ).toThrow(/sheets_user_oauth_subject_forbidden/);
    } finally {
      if (prev === undefined) delete process.env.OAUTH_SUBJECT;
      else process.env.OAUTH_SUBJECT = prev;
    }
  });

  it('defaults subject to ai@liao.info when neither arg nor env is set', () => {
    const path = writeTokenFile();
    const prev = process.env.OAUTH_SUBJECT;
    delete process.env.OAUTH_SUBJECT;
    try {
      const adapter = GoogleSheetsUserOauthAdapter.fromTokenFile({ tokenFilePath: path });
      expect(adapter).toBeInstanceOf(GoogleSheetsUserOauthAdapter);
      expect(OAUTH_SUBJECT_DEFAULT).toBe('ai@liao.info');
    } finally {
      if (prev !== undefined) process.env.OAUTH_SUBJECT = prev;
    }
  });

  it('rejects an empty subject', () => {
    const path = writeTokenFile();
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({ tokenFilePath: path, subject: '   ' }),
    ).toThrow(/sheets_user_oauth_subject_unset/);
  });
});

describe('GoogleSheetsUserOauthAdapter.fromTokenFile — token file validation', () => {
  it('throws a missing-file error when the token file is absent', () => {
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({
        tokenFilePath: join(tmpDir, 'does-not-exist.json'),
        subject: 'ai@liao.info',
      }),
    ).toThrow(/sheets_user_oauth_token_missing/);
  });

  it('throws when the token file is unparseable JSON', () => {
    const path = join(tmpDir, 'bad.json');
    writeFileSync(path, '{not json');
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/sheets_user_oauth_token_unparseable/);
  });

  it('throws when required fields are missing', () => {
    const path = join(tmpDir, 'partial.json');
    writeFileSync(path, JSON.stringify({ client_id: 'x' }));
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/sheets_user_oauth_token_invalid/);
  });

  it('throws when allowed_scopes is empty', () => {
    const path = writeTokenFile({ allowed_scopes: [] });
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/sheets_user_oauth_token_invalid/);
  });

  it('throws when allowed_scopes lacks spreadsheets.readonly', () => {
    const path = writeTokenFile({
      allowed_scopes: ['https://www.googleapis.com/auth/userinfo.email'],
    });
    expect(() =>
      GoogleSheetsUserOauthAdapter.fromTokenFile({
        tokenFilePath: path,
        subject: 'ai@liao.info',
      }),
    ).toThrow(/sheets_user_oauth_scope_missing/);
  });

  it('builds an adapter from a complete token file', () => {
    const path = writeTokenFile();
    const adapter = GoogleSheetsUserOauthAdapter.fromTokenFile({
      tokenFilePath: path,
      subject: 'ai@liao.info',
    });
    expect(adapter).toBeInstanceOf(GoogleSheetsUserOauthAdapter);
  });
});

describe('GoogleSheetsUserOauthAdapter.valuesGet', () => {
  it('returns the values grid from the underlying client', async () => {
    const captured: sheets_v4.Params$Resource$Spreadsheets$Values$Get[] = [];
    const client = mockClient({
      values: [
        ['Person', 'Mon', 'Tue'],
        ['Sally', 'W', 'L'],
      ],
      capturedParams: captured,
    });
    const adapter = new GoogleSheetsUserOauthAdapter(client);
    const result = await adapter.valuesGet({
      spreadsheetId: WL_LOG_DEFAULT_SHEET_ID,
      range: 'Roster!A1:ZZ',
    });
    expect(result.values).toEqual([
      ['Person', 'Mon', 'Tue'],
      ['Sally', 'W', 'L'],
    ]);
    expect(captured[0]?.spreadsheetId).toBe(WL_LOG_DEFAULT_SHEET_ID);
    expect(captured[0]?.range).toBe('Roster!A1:ZZ');
  });

  it('defaults valueRenderOption to UNFORMATTED_VALUE', async () => {
    const captured: sheets_v4.Params$Resource$Spreadsheets$Values$Get[] = [];
    const client = mockClient({ values: [], capturedParams: captured });
    const adapter = new GoogleSheetsUserOauthAdapter(client);
    await adapter.valuesGet({
      spreadsheetId: 'sheet-A',
      range: 'A1:Z',
    });
    expect(captured[0]?.valueRenderOption).toBe('UNFORMATTED_VALUE');
  });

  it('honours an explicit valueRenderOption', async () => {
    const captured: sheets_v4.Params$Resource$Spreadsheets$Values$Get[] = [];
    const client = mockClient({ values: [], capturedParams: captured });
    const adapter = new GoogleSheetsUserOauthAdapter(client);
    const opts: ValuesGetOptions = {
      spreadsheetId: 'sheet-A',
      range: 'A1:Z',
      valueRenderOption: 'FORMATTED_VALUE',
    };
    await adapter.valuesGet(opts);
    expect(captured[0]?.valueRenderOption).toBe('FORMATTED_VALUE');
  });

  it('returns [] when the API response carries no values', async () => {
    const client = mockClient({});
    const adapter = new GoogleSheetsUserOauthAdapter(client);
    const result = await adapter.valuesGet({
      spreadsheetId: 'sheet-A',
      range: 'A1:Z',
    });
    expect(result.values).toEqual([]);
  });
});

describe('exchangeRefreshToken — OAuth2 refresh path against a mocked token endpoint', () => {
  const TOKEN: UserOauthTokenFile = Object.freeze({
    client_id: 'test-client-id',
    client_secret: 'test-client-secret',
    refresh_token: 'test-refresh-token',
    token_uri: 'https://oauth2.googleapis.com/token',
    allowed_scopes: Object.freeze([SPREADSHEETS_READONLY_SCOPE]),
  });

  it('exchanges refresh token for access token at the token endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-1', expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await exchangeRefreshToken(TOKEN);
    expect(result.access_token).toBe('access-1');
    expect(result.expires_in).toBe(3600);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect((init as RequestInit).method).toBe('POST');
    const body = (init as RequestInit).body as URLSearchParams;
    const params = new URLSearchParams(body.toString());
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('test-refresh-token');
    expect(params.get('client_id')).toBe('test-client-id');
    expect(params.get('client_secret')).toBe('test-client-secret');
    expect(params.get('scope')).toBe(SPREADSHEETS_READONLY_SCOPE);
  });

  it('rejects synchronously when the requested scope is not in allowed_scopes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      exchangeRefreshToken(TOKEN, 'https://www.googleapis.com/auth/spreadsheets'),
    ).rejects.toThrow(
      /sheets_user_oauth_scope_denied requested=https:\/\/www\.googleapis\.com\/auth\/spreadsheets/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('surfaces a typed error with status when the token endpoint returns non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":"invalid_grant"}', { status: 400 }),
    );
    await expect(exchangeRefreshToken(TOKEN)).rejects.toThrow(
      /sheets_user_oauth_refresh_failed status=400 body=\{"error":"invalid_grant"\}/,
    );
  });
});

describe('SPREADSHEETS_READONLY_SCOPE', () => {
  it('is exactly spreadsheets.readonly', () => {
    expect(SPREADSHEETS_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    );
  });
});
