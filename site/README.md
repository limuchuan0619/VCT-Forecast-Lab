# Public Site

This directory contains the public prediction UI, D1 schema, immutable prediction ledger and DeepSeek evidence-bound diagnosis workflow.

Key files:

- [schema.ts](db/schema.ts)
- [prediction-store.ts](lib/prediction-store.ts)
- [deepseek.ts](lib/deepseek.ts)
- [result route](app/api/automation/results/route.ts)
- [prediction detail](app/predictions/[id]/page.tsx)

Local verification:

\`\`\`powershell
npm ci
npm run build
\`\`\`

The portfolio Vite configuration uses a placeholder local D1 binding. The production Sites project ID, D1 instance, runtime variables and hosting configuration are intentionally excluded. This folder is not the production deployment source.
