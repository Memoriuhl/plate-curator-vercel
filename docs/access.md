# Access: how the dashboard reaches Firebase

The dashboard reads and writes the **staging** Firebase project (`license-plate-game-staging`) from Vercel Functions. It holds **no service-account key**. Every function call proves who it is with a short-lived token that Vercel signs, and Google trades that token for a short-lived access token.

## The chain

```
Vercel Function
  │  getVercelOidcToken()            OIDC token signed by https://oidc.vercel.com/memoriuhl
  ▼                                  (claims include project = plate-curator-vercel, environment)
Google STS  (sts.googleapis.com)
  │  checks the token against Workload Identity pool "vercel", provider "vercel-oidc"
  │  provider condition: assertion.project == "plate-curator-vercel"
  ▼
IAM Credentials  (impersonate dashboard@license-plate-game-staging.iam.gserviceaccount.com)
  │  allowed because the pool's principal set holds roles/iam.workloadIdentityUser on that account
  ▼
Firestore / Cloud Storage in license-plate-game-staging, with the service account's roles
```

The code is `lib/gcp/credentials.ts` (asks Vercel Connect for the `firebase/plate-curator-vercel` token) and `lib/gcp/firestore.ts` (one client per function instance). `/api/health/firebase` exercises the whole chain and returns `{ "catalogVersion": <n> }`.

## What the service account may do

| Role | On | Why |
|---|---|---|
| `roles/datastore.user` | project `license-plate-game-staging` | read and write Firestore documents |
| `roles/storage.objectAdmin` | the staging storage bucket | read and replace plate images |

The account has no roles on the production project, so a misconfigured project ID fails with permission denied instead of touching the live game.

## Environment variables

Set in Vercel for **Preview** and **Production**. None of them are secrets.

| Name | Meaning |
|---|---|
| `GCP_PROJECT_ID` | the staging project ID |
| `FIREBASE_STORAGE_BUCKET` | the staging bucket |
| `NEXT_PUBLIC_FIREBASE_*` | the browser Firebase config for sign-in |

## Running it locally

```sh
vercel env pull .env.local --environment=preview
npm run dev
curl -i http://localhost:3000/api/health/firebase
```

`vercel env pull` also writes `VERCEL_OIDC_TOKEN`, which lasts about 12 hours. Pull again when calls start failing with an expired token. `.env.local` is gitignored.

## Cutting access

- **Stop every deployment at once:** disable the `vercel-oidc` provider, or remove the `workloadIdentityUser` binding on the service account.
- **Narrow it:** tighten the provider condition, for example to `assertion.environment == "production"`.
- Nothing needs rotating, because no long-lived key exists.
