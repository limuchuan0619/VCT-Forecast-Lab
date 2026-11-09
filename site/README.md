# Public Site

This directory contains the public prediction UI, D1 schema, immutable prediction ledger and DeepSeek evidence-bound diagnosis workflow.

Key files:

- [schema.ts](db/schema.ts)
- [prediction-store.ts](lib/prediction-store.ts)
- [deepseek.ts](lib/deepseek.ts)
- [result route](app/api/automation/results/route.ts)
- [prediction detail](app/predictions/[id]/page.tsx)

Local verification:

```powershell
npm ci
npm test
npm run build
```

The portfolio Vite configuration uses a placeholder local D1 binding. The production Sites project ID, D1 instance, runtime variables and hosting configuration are intentionally excluded. This folder is not the production deployment source.

The public seed migration is an explicitly empty local initialization. Historical production counts and real match rows are not seeded. Initialize the included schema migrations into your own local D1 database before exercising data-backed pages; a successful build alone does not provision a database or validate a live provider.

The exported source corresponds to Sites Version44. Navigation groups prediction history/details and match reviews under Home, with model comparison under Model Lab. Deterministic settlement, source evidence and AI hypotheses remain separate. AI tests use isolated fixtures and mocked provider responses, not paid live DeepSeek calls.
