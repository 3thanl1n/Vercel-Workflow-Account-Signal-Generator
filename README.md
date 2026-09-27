# Signal Gen

A daily durable workflow on Vercel that compares each account's product usage with its Salesforce record, flags accounts with plain if-then rules, ranks them by dollars at stake, has a Claude agent investigate the top movers (running analysis code in a Vercel Sandbox), and posts Slack alerts with a draft email. Approving an alert logs a follow-up task in Salesforce.

Side project with dummy data: a Salesforce trial org seeded with 25 fictional AI companies, plus generated usage data.

**Status:** the daily run is live (cron at 12:00 UTC). It generates the day's usage, loads Salesforce and 28 days of usage, ranks every account, posts a plain Slack summary of the top 5, and logs the run to Postgres. The agent comes next.

## Stack
Next.js 16, Workflow SDK 5 (beta), AI SDK 7, Vercel Sandbox, Neon Postgres, Vercel Connect (Salesforce and Slack), Vercel Cron.

## How the daily run works
`src/workflows/daily-signals.ts`. Each step retries on its own and saves its result, so a crash or redeploy resumes where it left off.

1. **Generate usage.** Fills any missing day in the last 30. Rows are deterministic, so reruns add nothing.
2. **Load Salesforce.** Accounts, plan, commit, renewal date and open opportunities.
3. **Load usage.** 28 days of rows, summarized per account inside the step so the step result stays small.
4. **Prioritize.** The rules in `src/lib/rules.ts`: usage jump, usage drop, commit pace, new model (all in dollars per year), and error spike (context only). The priority is the largest dollar value, not the sum.
5. **Post the Slack summary.** It checks the run log first, so a retry never posts twice.
6. **Log the run** in the `runs` table. A failed run is logged as `failed`, with the error.

## Why two models
Claude does the account analysis: hard reasoning with tools, where quality matters most. An open model on Baseten (GLM 5.3 Flash) writes the follow-up emails: a simple, repeated writing job where a small model is cheaper and faster, at about $0.15/$0.50 per 1M input/output tokens vs $2/$10 for Claude Sonnet 5 (the plan was Opus 5.5 at $4/$20, but it's gated on this account; the model is one constant in `src/lib/models.ts`). Every draft is checked (subject 80 characters or less, body 150 words or less, at least one number). A draft that fails the check, or a Baseten call that fails after its retries, falls back to Claude; if both fail, the alert goes out without a draft. See `src/lib/email-draft.ts`.

## Credentials
No Salesforce or Slack secret is stored in env vars. Vercel Connect issues short-lived tokens at call time:
- **Salesforce:** the OAuth 2.0 JWT bearer flow. Vercel signs an assertion for a pre-authorized integration user (`SALESFORCE_USERNAME`), so the cron works with no one logged in.
- **Slack:** a Slack app that Vercel Connect registered in the workspace.
- **Postgres, Sandbox and AI Gateway:** credentials come from Vercel (the Neon integration and OIDC).
- **Baseten:** `BASETEN_API_KEY`, only in Vercel env vars (and the git-ignored `.env.local`). It never goes into code or the sandbox.

## Run locally
```bash
npm install
vercel link && vercel env pull     # OIDC token, DATABASE_URL, secrets into .env.local
npm run db:setup                   # create tables (safe to rerun)
npm run db:backfill                # 30 days of usage (safe to rerun)
npm run sf:setup -- --allow-non-developer-org   # Salesforce fields and seed data (safe to rerun)
npm test                           # rules, week windows, planted stories
npm run dev
curl -X POST localhost:3000/api/run-now -H "Authorization: Bearer $RUN_NOW_SECRET"          # today
curl -X POST localhost:3000/api/run-now -H "Authorization: Bearer $RUN_NOW_SECRET" -d '{"day":"2026-09-20"}'
npx workflow web                   # inspect runs and steps
```

## Known limits
- The thresholds are guesses, and we planted the stories the rules find. This proves the plumbing, not predictive power.
- The Salesforce org is a 30-day Enterprise Edition trial that expires on 2026-10-26.
- Workflow SDK 5 is a beta (required by `@ai-sdk/workflow` for `WorkflowAgent`), so versions are pinned exactly.
- `npm audit` flags an old `nanoid` bundled inside the Workflow beta's `@workflow/core`. The suggested `--force` fix would downgrade Workflow.
- Hobby cron fires once a day, anytime within the scheduled hour.
