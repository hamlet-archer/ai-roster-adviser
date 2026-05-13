import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContractValidator } from '../contracts.js';

const CONTRACTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts');

function validQueryEnvelope() {
  return {
    contract_id: 'roster.query.v1',
    trace_id: '01890000-0000-7000-8000-00000000aaaa',
    dedupe_key: 'sha256:k',
    source_ref: 'test',
    caller_agent_id: 'test-caller',
    person: 'sally',
    date: '2026-05-13',
  };
}

function validRangeEnvelope() {
  return {
    contract_id: 'roster.range.v1',
    trace_id: '01890000-0000-7000-8000-00000000bbbb',
    dedupe_key: 'sha256:k',
    source_ref: 'test',
    caller_agent_id: 'test-caller',
    people: ['sally', 'chloe'],
    window: { start: '2026-05-13', end: '2026-05-19' },
  };
}

describe('contracts validator', () => {
  it('accepts a well-formed roster.query.v1 envelope', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const result = v.validate(validQueryEnvelope());
    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed roster.range.v1 envelope', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const result = v.validate(validRangeEnvelope());
    expect(result.ok).toBe(true);
  });

  it('rejects an envelope missing a required field', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const payload = validQueryEnvelope() as Record<string, unknown>;
    delete payload.date;
    const result = v.validate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toMatch(/date/);
    }
  });

  it('rejects ai-doer person enum at the contract layer (handler synth happens after)', () => {
    // ai-doer IS in the contract enum, so this is actually accepted — guard
    // that the enum is the union we expect, not narrower.
    const v = buildContractValidator(CONTRACTS_DIR);
    const payload = { ...validQueryEnvelope(), person: 'ai-doer' };
    expect(v.validate(payload).ok).toBe(true);
  });

  it('rejects a person not in the v1 enum (e.g. mkkk)', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const payload = { ...validQueryEnvelope(), person: 'mkkk' };
    const result = v.validate(payload);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown contract_id', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const payload = { ...validQueryEnvelope(), contract_id: 'roster.unknown.v1' };
    const result = v.validate(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toMatch(/unknown contract_id/);
    }
  });

  it('rejects a non-object envelope', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    expect(v.validate('not an object').ok).toBe(false);
    expect(v.validate(null).ok).toBe(false);
  });

  it('rejects a range envelope with > 4 people (contract maxItems)', () => {
    const v = buildContractValidator(CONTRACTS_DIR);
    const payload = {
      ...validRangeEnvelope(),
      people: ['kelvin', 'sally', 'chloe', 'ai-doer', 'kelvin'],
    };
    const result = v.validate(payload);
    expect(result.ok).toBe(false);
  });
});
