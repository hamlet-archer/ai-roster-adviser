/**
 * bootstrap-oauth.ts — source-shape contract.
 *
 * The script's main path is interactive (live HTTP listener + browser
 * + Google OAuth round-trip); we cover the deterministic surface here.
 * Smoke-coverage of the interactive flow comes from Kelvin running the
 * script once (G6.15b operator_observable).
 *
 * Mirrors ai-calendar-adviser's `bootstrap-oauth-arg-parse.test.ts` (G6.5b)
 * and ai-comms-adviser's (G2); the ai-roster-adviser variant is narrower
 * (single subject, single scope = spreadsheets.readonly) so the matrix is
 * small.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'bootstrap-oauth.ts');
const SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

describe('bootstrap-oauth — file shape contract', () => {
  it("writes a JSON file with the fields GoogleSheetsUserOauthAdapter expects", () => {
    // Fields the adapter's loadAndValidateTokenFile validator requires:
    for (const field of [
      'client_id',
      'client_secret',
      'refresh_token',
      'token_uri',
      'allowed_scopes',
    ]) {
      expect(SOURCE).toContain(`${field}:`);
    }
    // G6.15b acceptance fields:
    for (const field of ['granted_at', 'granted_subject']) {
      expect(SOURCE).toContain(`${field}:`);
    }
  });

  it('forces prompt=consent so Google always returns a refresh_token', () => {
    expect(SOURCE).toMatch(/prompt:\s*['"]consent['"]/);
  });

  it('uses PKCE (S256) for the authorization-code exchange', () => {
    expect(SOURCE).toContain("code_challenge_method: 'S256'");
    expect(SOURCE).toContain('code_verifier');
  });

  it('refuses to overwrite an existing token file without --force', () => {
    expect(SOURCE).toMatch(/refusing to overwrite [^\n]+--force/);
  });

  it('writes the token file with mode 0600', () => {
    expect(SOURCE).toContain('mode: 0o600');
  });

  it('binds the redirect listener to 127.0.0.1 (never 0.0.0.0)', () => {
    expect(SOURCE).toContain(`'127.0.0.1'`);
    expect(SOURCE).not.toContain(`'0.0.0.0'`);
  });
});

describe('bootstrap-oauth — subject coverage (single subject, roster-adviser variant)', () => {
  it("defaults the subject to ai@liao.info (the system's identity)", () => {
    expect(SOURCE).toContain(`'ai@liao.info'`);
    expect(SOURCE).toMatch(/DEFAULT_SUBJECT\s*=\s*['"]ai@liao\.info['"]/);
  });

  it("includes kelvin@liao.info in FORBIDDEN_SUBJECTS per feedback_no_kelvin_account_impersonation", () => {
    expect(SOURCE).toMatch(
      /FORBIDDEN_SUBJECTS\s*=\s*Object\.freeze\(\[['"]kelvin@liao\.info['"]\]/,
    );
  });

  it("defaults the scope to spreadsheets.readonly only", () => {
    expect(SOURCE).toContain(`'https://www.googleapis.com/auth/spreadsheets.readonly'`);
    expect(SOURCE).toMatch(/\['spreadsheets\.readonly'\]/);
  });

  it("refuses subject=kelvin@liao.info at parse-time", () => {
    expect(SOURCE).toMatch(
      /FORBIDDEN_SUBJECTS[^)]*\)\.includes\(subject\)/,
    );
  });

  it("refuses scope sets that lack spreadsheets.readonly (adapter contract)", () => {
    expect(SOURCE).toMatch(/--scopes must include spreadsheets\.readonly/);
  });
});
