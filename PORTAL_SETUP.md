# Getting leads out of 99acres and MagicBricks

## The short version

Both portals **push** leads to a URL you give them. You do not pull, poll, or
scrape. The whole integration is: deploy the Worker, get its URL, paste that
URL into each portal's dashboard.

```
99acres dashboard      ─┐
  Settings →            │   paste your URL   ┌────────────────────────┐
  Lead Management →     ├──────────────────▶ │  /api/intake/99acres    │
  Push API / Webhook   ─┘                    │  /api/intake/magicbricks│
                                             └────────────────────────┘
MagicBricks dashboard  ─┐                                 │
  Lead Delivery →       ├─────────────────────────────────┘
  Webhook / API        ─┘
```

## What to give them

After `npx wrangler deploy` you have a URL. Hand each portal **its own** URL
with **its own** token:

```
https://realestate-crm.<subdomain>.workers.dev/api/intake/99acres?token=<INTAKE_TOKEN_99ACRES>
https://realestate-crm.<subdomain>.workers.dev/api/intake/magicbricks?token=<INTAKE_TOKEN_MAGICBRICKS>
```

Separate tokens on purpose: if one portal's config leaks, rotate that one with
`npx wrangler secret put INTAKE_TOKEN_99ACRES` and the other keeps working.

The token is in the query string because these dashboards give you a single
URL field and no way to set headers. If a portal *does* let you add headers,
prefer `X-Intake-Token: <token>` and leave `?token=` off the URL — the Worker
accepts either.

## Exact steps

### 99acres

1. Sign in to your **99acres seller/advertiser dashboard**.
2. Go to **Settings → Lead Management → Push API / Webhook**.
3. Paste the `/api/intake/99acres?token=…` URL.
4. Save, then trigger a test enquiry on one of your listings.

If that menu is not visible, it is not enabled on your account tier — contact
your **99acres relationship manager** and ask for *"lead push API / webhook
integration"* by name. This is an account-managed feature, not self-serve for
everyone.

### MagicBricks

1. Sign in to your **MagicBricks advertiser account**.
2. Go to **Lead Delivery → Webhook / API**.
3. Paste the `/api/intake/magicbricks?token=…` URL.
4. Save and trigger a test enquiry.

Same fallback: if the option is missing, ask your **MagicBricks account
manager** for *"lead API / CRM push integration"*.

Neither portal publishes this publicly — it is provisioned per advertiser
account, so the menu names above may differ slightly by account tier and
year. The thing to ask for is unambiguous, though: *push my leads to my own
webhook URL*.

## What the Worker accepts

Deliberately permissive, because you don't control how the portal sends it.
All of the following work and were tested:

| Transport | Example |
|---|---|
| POST, JSON body | `Content-Type: application/json` |
| POST, form-encoded | `Content-Type: application/x-www-form-urlencoded` |
| GET, query string | MagicBricks is documented as delivering leads as URL parameters |
| Body with wrong/missing content-type | falls back to trying JSON, then form parsing |

Field names are matched case-insensitively across many known spellings, so
99acres's `First_Name` / `Mobile` / `Project_Name` / `City` / `Price` and
MagicBricks's `senderName` / `senderPhone` / `propType` all map without
configuration. Verified against both shapes.

## The first real lead is the one that matters

Everything above is based on integration docs and third-party CRM guides, not
on a payload I have seen from your account. **Assume the mapping is 90% right
and verify the last 10% on the first live lead.**

The Worker stores the complete original payload verbatim on every lead, so:

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" \
  "https://<your-worker>/api/leads?limit=1" | jq '.leads[0].raw_payload | fromjson'
```

Compare that against the parsed columns next to it. Anything the portal sent
that landed in `raw_payload` but not in a column is a mapping gap — tell me
the key name and it is a one-line fix in `normaliseLead()`.

## First-lead checks

1. Confirm the portal's unique lead ID key if available. ID-less requests use an exact canonical payload fingerprint for 24 hours; changed retry payloads can require adjustment.
2. Confirm property codes and set `PROPERTY_CODE_MAP` in `wrangler.jsonc`. Do not infer property types from arbitrary codes.
3. Confirm lead timestamps, contact fields and budget values against `raw_payload`.

## If a portal refuses API access

Some smaller advertiser accounts only get leads by email. The documented
fallback used by other CRMs is email parsing: portals send a lead notification
email, the CRM parses it. On Cloudflare that would be **Email Routing → a
Worker**, reusing the same `normaliseLead()` and assignment engine — the
intake transport changes, nothing downstream does. Not built; say the word if
you need it.
