# MJ Art Cloudflare App

Separate Cloudflare Worker app for MJ Art. The layout and deploy flow mirror Drawer Organiser.

## Project Structure

- `apps/web/` - deployable Cloudflare Worker app
- `apps/web/public/` - public static assets
- `apps/web/src/worker.js` - Cloudflare Worker API
- `apps/web/wrangler.jsonc` - Cloudflare config
- `.github/workflows/deploy-cloudflare.yml` - GitHub Actions deploy workflow

## What This Adds

- Public gallery reads artwork metadata from `/api/artworks`.
- Admin page signs in with a Cloudflare secret password.
- Admin changes save directly to Cloudflare R2 as `artworks.json`.
- Admin image uploads save to the same Cloudflare R2 bucket.
- Uploaded images are served from `/artwork-uploaded/...`.

## Deploy Flow

- Pushes to `main` deploy production through GitHub Actions.
- Manual workflow dispatch can deploy `preview` or `production`.
- Local Wrangler deploy should only be used if `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are available in the shell.

## Required Cloudflare Setup

Create the separate storage resources:

```sh
pnpm --filter @mj-art/web exec wrangler r2 bucket create mj-art-images --location apac
pnpm --filter @mj-art/web exec wrangler r2 bucket create mj-art-images-preview --location apac
```

The GitHub Actions deploy workflow also creates these R2 buckets if they do not already exist.

Set admin secrets:

```sh
pnpm --filter @mj-art/web exec wrangler secret put ADMIN_PASSWORD --env production
pnpm --filter @mj-art/web exec wrangler secret put ADMIN_SESSION_SECRET --env production
pnpm --filter @mj-art/web exec wrangler secret put ADMIN_PASSWORD --env preview
pnpm --filter @mj-art/web exec wrangler secret put ADMIN_SESSION_SECRET --env preview
```

Deploy:

```sh
pnpm install
pnpm --filter @mj-art/web cf:deploy:production
```

## URLs

- Public site: `/`
- Admin site: `/admin.html`
- Health check: `/api/health`
