# Signal Gen

A daily durable workflow on Vercel that compares each account's product usage with its Salesforce record, scores every account in plain code, has a Claude agent investigate the top movers (running analysis code in a Vercel Sandbox), and posts Slack alerts with a draft email. Approving an alert logs a follow-up task in Salesforce.

Side project with dummy data (a Salesforce Developer Edition org plus generated usage data).

**Status:** Day 1, skeleton. A hello-world workflow proves durable steps, a durable sleep, Postgres (Neon) and Vercel Sandbox work together.

## Stack
Next.js 16, Workflow SDK 5 (beta), AI SDK 7, Vercel Sandbox, Neon Postgres, Vercel Connect (Salesforce), Slack.

## Run locally
```bash
npm install
vercel link && vercel env pull   # OIDC token + DATABASE_URL into .env.local
npm run dev
curl -X POST localhost:3000/api/run-now -H "Authorization: Bearer $RUN_NOW_SECRET"
npx workflow web                  # inspect runs and steps
```

## Known limits
- Workflow SDK 5 is a beta (required by `@ai-sdk/workflow` for `WorkflowAgent`); versions are pinned exactly.
- `npm audit` flags an old `nanoid` bundled inside the Workflow beta's `@workflow/core`; the suggested `--force` fix would downgrade Workflow.
