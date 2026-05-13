/**
 * Loads + compiles the two RPC request contracts from `contracts/` (vendored
 * from ai-ops-meta until `@hamlet-archer/ai-ops-contracts` ships). Mirrors
 * the calendar-adviser shape — same Ajv2020 config (`strict: false` because
 * the schemas use `description` annotation keywords) + the same envelope-
 * level validate(unknown) → discriminated result.
 */

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { default as addFormats } from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type ContractId = 'roster.query.v1' | 'roster.range.v1';

export const SUPPORTED_CONTRACTS: readonly ContractId[] = [
  'roster.query.v1',
  'roster.range.v1',
];

export interface ContractEnvelope {
  readonly contract_id: ContractId;
  readonly trace_id: string;
  readonly dedupe_key: string;
  readonly source_ref: string;
  readonly caller_agent_id: string;
  // Contract-specific fields land at top level alongside the envelope fields
  // — the schemas in contracts/*.json are flat objects.
  readonly [k: string]: unknown;
}

export interface ContractValidator {
  validate(envelope: unknown): { ok: true; value: ContractEnvelope } | { ok: false; errors: string };
}

function defaultContractsDir(): string {
  // ESM-safe equivalent of __dirname. The compiled file lives at
  // `dist/contracts.js`; `contracts/` is a sibling of `dist/`.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'contracts');
}

export function buildContractValidator(contractsDir: string = defaultContractsDir()): ContractValidator {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
  });
  (addFormats as unknown as (ajv: Ajv2020) => void)(ajv);

  const compiled: Partial<Record<ContractId, ValidateFunction>> = {};
  for (const id of SUPPORTED_CONTRACTS) {
    const raw = readFileSync(resolve(contractsDir, `${id}.json`), 'utf8');
    const schema = JSON.parse(raw) as Record<string, unknown>;
    compiled[id] = ajv.compile(schema);
  }

  function fmtErrors(errors: ValidateFunction['errors']): string {
    if (!errors) return 'unknown validation error';
    return errors
      .map((e) => `${e.instancePath || '(root)'} ${e.message ?? ''}`.trim())
      .join('; ');
  }

  return {
    validate(envelope: unknown) {
      if (!envelope || typeof envelope !== 'object') {
        return { ok: false, errors: 'envelope is not an object' };
      }
      const obj = envelope as { contract_id?: unknown };
      const id = obj.contract_id;
      if (typeof id !== 'string') {
        return { ok: false, errors: 'contract_id missing or not a string' };
      }
      if (!SUPPORTED_CONTRACTS.includes(id as ContractId)) {
        return { ok: false, errors: `unknown contract_id '${id}'` };
      }
      const validator = compiled[id as ContractId];
      if (!validator) {
        return { ok: false, errors: `validator missing for contract_id '${id}'` };
      }
      if (!validator(envelope)) {
        return { ok: false, errors: fmtErrors(validator.errors) };
      }
      return { ok: true, value: envelope as ContractEnvelope };
    },
  };
}
