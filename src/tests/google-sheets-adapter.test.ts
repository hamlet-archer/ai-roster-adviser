import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GoogleSheetsAdapter,
  SPREADSHEETS_READONLY_SCOPE,
  WL_LOG_DEFAULT_SHEET_ID,
} from '../google-sheets-adapter.js';

describe('GoogleSheetsAdapter — constant exports', () => {
  it('exposes the readonly Sheets scope used by DwD', () => {
    expect(SPREADSHEETS_READONLY_SCOPE).toBe(
      'https://www.googleapis.com/auth/spreadsheets.readonly',
    );
  });

  it('exposes the canonical W&L Log sheet id', () => {
    expect(WL_LOG_DEFAULT_SHEET_ID).toBe(
      '1nxa9K_B5iGj9EAfpSuSo48IHlQEIgW9MRDvMgdbzXqU',
    );
  });
});

describe('GoogleSheetsAdapter.fromCredentialsFile — fail-loud paths', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'roster-key-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('throws when DWD_KEY_PATH and keyFilePath are both unset', () => {
    const oldKey = process.env.DWD_KEY_PATH;
    const oldSubj = process.env.DWD_IMPERSONATE_SUBJECT;
    delete process.env.DWD_KEY_PATH;
    delete process.env.DWD_IMPERSONATE_SUBJECT;
    try {
      expect(() => GoogleSheetsAdapter.fromCredentialsFile({})).toThrow(/DWD_KEY_PATH/);
    } finally {
      if (oldKey !== undefined) process.env.DWD_KEY_PATH = oldKey;
      if (oldSubj !== undefined) process.env.DWD_IMPERSONATE_SUBJECT = oldSubj;
    }
  });

  it('throws when DWD_IMPERSONATE_SUBJECT is missing', () => {
    const path = join(dir, 'key.json');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'service_account',
        client_email: 'sa@project.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    expect(() => GoogleSheetsAdapter.fromCredentialsFile({ keyFilePath: path })).toThrow(
      /DWD_IMPERSONATE_SUBJECT/,
    );
  });

  it('throws when the key file is missing required fields', () => {
    const path = join(dir, 'key.json');
    writeFileSync(
      path,
      JSON.stringify({
        type: 'service_account',
        client_email: 'sa@project.iam.gserviceaccount.com',
        // private_key missing
        token_uri: 'https://oauth2.googleapis.com/token',
      }),
    );
    expect(() =>
      GoogleSheetsAdapter.fromCredentialsFile({
        keyFilePath: path,
        subject: 'kelvin@liao.info',
      }),
    ).toThrow(/private_key/);
  });
});

describe('GoogleSheetsAdapter.valuesGet — delegates to googleapis client', () => {
  it('passes spreadsheetId + range + UNFORMATTED_VALUE through', async () => {
    const calls: unknown[] = [];
    const fakeClient = {
      spreadsheets: {
        values: {
          get: async (params: unknown) => {
            calls.push(params);
            return { data: { values: [['Name', '2026-05-13']] } };
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    const adapter = new GoogleSheetsAdapter(fakeClient);
    const result = await adapter.valuesGet({
      spreadsheetId: 'sheet-1',
      range: 'A1:Z1',
    });
    expect(result.values).toEqual([['Name', '2026-05-13']]);
    expect(calls[0]).toEqual({
      spreadsheetId: 'sheet-1',
      range: 'A1:Z1',
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
  });
});
