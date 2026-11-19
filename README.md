# Real-estate CRM on Cloudflare Free

Active hosting choice: Cloudflare Workers + D1, selected 2026-09-10. This is the custom CRM in this folder. Existing EspoCRM data remains in local Docker and is not automatically migrated.

## Cost boundary

Use **Workers Free**, not Workers Paid. No R2 bucket, paid trial or purchased domain is required. Deployment uses the included `workers.dev` hostname.

- Workers: 100,000 requests per day, 10 ms CPU per request on Free.
- D1: 5 million rows read/day, 100,000 rows written/day, 5 GB total storage across the account. Individual Free databases have a smaller size limit; check Cloudflare's current limits before approaching capacity.
- Free quotas are account-wide. D1 stops accepting operations when Free limits are exceeded; it does not automatically buy an upgrade. Keep the account on Free. Index writes also count toward usage.

Sources checked 2026-09-10: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## Local use

```sh
npm ci
npm run db:local
npm test
npm run dev
```

Open the printed local URL. The responsive workspace includes a lead inbox, workload overview, stage and source filters, employee workload, routing rules, and a detailed lead workspace. A lead records stage, priority, follow-up reminder, activity history, transfer requests and its original portal payload. Layout adapts to mobile and desktop; keyboard users can open leads and operate the native detail dialog. Sign in with `ADMIN_TOKEN` from `.dev.vars`; this file stays local.

The schema and demo seed now preserve existing data when reapplied. Tests use an isolated, temporary D1 database and never touch local or remote CRM records.

## Deploy to your free account

1. Run `npx wrangler login --scopes account:read user:read workers:write workers_scripts:write d1:write` and complete browser authorization.
2. Check the account is on Workers Free. Run `npx wrangler d1 list` and reuse the intended CRM database if one exists; otherwise `npx wrangler d1 create crm`. Paste its UUID into `wrangler.jsonc`.
3. Run `npx wrangler d1 execute crm --remote --file=schema.sql`. On a new demo installation only, apply `seed.sql`. Demo agents are placeholders, not real employee accounts. For an existing deployment, apply each file in `migrations/` in order before deploying its matching code.
4. Set the intake secrets with `npx wrangler secret put INTAKE_TOKEN_99ACRES` (and `INTAKE_TOKEN_MAGICBRICKS`, `INTAKE_TOKEN_METAADS`) using separate random values. For the super administrator's login run `node scripts/hash-password.mjs` (it asks for the password and prints a hash), then `npx wrangler secret put SUPER_ADMIN_EMAIL` and `npx wrangler secret put SUPER_ADMIN_PASSWORD_HASH`. The account is created from these the first time that email signs in; after that the password is changed from the app (account menu → Change my password). The old `ADMIN_TOKEN` is no longer used. Never deploy the `dev-*` sample values.
5. Run `npm test` and `npx wrangler deploy --dry-run`, then `npm run deploy`.
6. Verify `/api/health`, admin authentication, a synthetic portal lead, duplicate redelivery and assignment history at the returned URL.

The production workspace is deployed at `https://realestate-crm.realestate-crm.workers.dev` in info.digiteq00@gmail.com’s account. Workers Free was verified in the account dashboard. Production tokens are stored in the ignored, owner-readable `.production-secrets.json`; never commit or share that file. `ACCESS.md` contains private sign-in and portal configuration details.

## Intake and assignment

The two token-protected endpoints are:

```
https://YOUR_WORKER.workers.dev/api/intake/99acres?token=YOUR_99ACRES_TOKEN
https://YOUR_WORKER.workers.dev/api/intake/magicbricks?token=YOUR_MAGICBRICKS_TOKEN
```

Both accept GET query parameters, POST JSON and form bodies. `X-Intake-Token` may replace the URL token. Bodies are limited to 64 KiB. Credential fields are stripped before storing the raw payload. Worker request logging is disabled to avoid recording token-bearing URLs.

Portal IDs deduplicate indefinitely within each source. Without an ID, a canonical payload fingerprint deduplicates identical enquiries for 24 hours. Different projects from the same phone remain separate enquiries. Retry claims, lead insertion, automatic assignment and initial history commit together in D1. Failures roll back together; callers receive 503 and can retry. Changed retry payloads may still need alias/fingerprint adjustments after observing the real portal.

The most specific active routing rule wins (source plus property type, then either, then catch-all). Strategy is round-robin or least-loaded. The supplied catch-all rule uses **least-loaded**, counting each agent’s open leads (`new`, `assigned`, `in_process`) at assignment time. Selection happens inside an insertion trigger, so concurrent requests see preceding committed assignments. `accepts_leads=0`, inactive employees, and employees outside the routed team are excluded. Invalid manual user/team combinations are rejected.

Set `vars.PROPERTY_CODE_MAP` in `wrangler.jsonc` to confirmed portal code/type pairs, for example `{"CONFIRMED_CODE":"Office"}`. The production map remains empty until actual portal codes are known.

## Employee access and lead workflow

People sign in with an email and a password (the super administrator's login comes from `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD_HASH`). From **People**, the super administrator creates accounts (email + password), chooses the role, assigns a team, sets a new password for anyone who forgets theirs, and controls availability and whether the employee receives new leads. Five wrong passwords pause sign-in for that email for 15 minutes; sessions last 14 days and end when someone is deactivated, marked as left, or has their password reset.

Agents see only their own leads. Managers have team visibility and can reassign directly within their permitted scope. Administrators can work across the workspace. Per-user allow/deny overrides are stored for API-managed role extensions. The super administrator is the only role that can create employees, change access status, or alter permissions.

An agent cannot silently pass a lead to a colleague. They create a transfer request; the selected recipient must accept it before the owner changes. The request, decision and resulting assignment remain in the lead audit trail. A lead also has a stage (`new` through `won`, `lost` or `nurture`), priority, next follow-up reminder, stage history and logged notes/calls/meetings/tasks/emails.

Useful operational CRM features included here are contacts carried by leads, lead qualification stages, assignments, teams, routing, tasks, calls, meetings, notes, reminders, role access and audit history. EspoCRM’s broader modules such as accounting, marketing campaigns, email synchronisation and custom report builders are not cloned into this focused lead CRM.

## Meta Ads website form

For Facebook and Instagram campaigns that send visitors to a website, use the public enquiry page at `/enquire.html?campaign=meta-ad`. It reads the active property catalogue, creates a lead with source `Meta Ads`, and uses the normal automatic allocation flow. See [META_ADS_WEBSITE_FORM.md](META_ADS_WEBSITE_FORM.md) for the Ads Manager setup.

Real portal accounts still need lead-push/API delivery enabled. No real portal payload was supplied; verify first-lead fields, dates, prices and property codes against the stored raw payload. Configure actual employees and routing before using automatic assignment operationally. See [PORTAL_SETUP.md](PORTAL_SETUP.md).

Development dependency audit currently reports a transitive `sharp` image-decoder advisory in Wrangler/Miniflare. The deployed Worker has no runtime npm dependencies and does not process images. No forced downgrade of Wrangler was applied.
