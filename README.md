# ai-roster-adviser

Read-only RPC over the W&L Log Google Sheet — canonical staff working/leave roster. Backs Phase 3 task body enrichment grounding (the `## Constraints` H2's roster availability lines).

## Status

**Scaffold only.** No real ingestion yet. Implementation tracked in [ai-ops-meta `architect-backlog.md`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/architect-backlog.md) under Phase 3 grounding-source agents (ships THIRD after `web-fetcher`).

Design: [`docs/architecture.md` §6.8](https://github.com/hamlet-archer/ai-ops-meta/blob/main/docs/architecture.md) — Grounding-source rollout.

## Source of truth

Google Sheet ID: `1nxa9K_B5iGj9EAfpSuSo48IHlQEIgW9MRDvMgdbzXqU`

Reuses `ai@liao.info` Google OAuth (`feedback_shared_ai_credentials`) with scope `spreadsheets.readonly`. Sheet shared with `ai@liao.info` (Viewer is enough). Boot self-check fails loud on 403.

## Contracts

Accepts:
- [`roster.query.v1`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/contracts/roster.query.v1.json)
- [`roster.range.v1`](https://github.com/hamlet-archer/ai-ops-meta/blob/main/contracts/roster.range.v1.json)

Status enum: `working | leave | half-day | public-holiday | sick | unknown`.

## Privacy

`notes` (e.g. "sick — migraine") **never leave the agent**. The contract returns `status: 'sick'` and nothing else; `ai-chief` renders to peers as "not working" (`project_roster_semantics`).

## Special rules

- `ai-doer` is hard-coded as 24/7 working in the agent; never in the sheet. `roster.query.v1({person: 'ai-doer'})` always returns `status: 'working'`.
- Public holidays handled via a separate future `holidays.<region>.v1` feed — NOT in the W&L Log.
- Annual-leave-on-public-holidays is a separate per-staff pool field per `project_roster_semantics`.

## Boot self-check (AP-3 + AP-4 / AP-6)

1. Validate Google OAuth token against `ai@liao.info` with `spreadsheets.readonly` scope.
2. Sheet-shape probe on first boot writes `/etc/roster-adviser/sheet-mapping.yaml`.
3. Header hash validated each sync; mismatch = fail loud, **no auto-reprobe** (AP-6 — schema drift requires human-eyes).

## Develop

```
npm install
npm test
npm run build
```
