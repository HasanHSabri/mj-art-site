# MJ Art Site

Cloudflare Worker app for MJ's artwork, with a public gallery and password-protected admin surface.

Repo:
- https://github.com/HasanHSabri/mj-art-site

Project structure:
- `apps/web/` - deployable Cloudflare Worker app
- `apps/web/public/` - public static assets
- `apps/web/src/worker.js` - Cloudflare Worker API
- `apps/web/wrangler.jsonc` - Cloudflare config
- `.github/workflows/deploy-cloudflare.yml` - GitHub Actions deploy workflow
- `archive/` - inactive, non-production material (policy & recovery guide: `archive/README.md`); the previous GitHub Pages site now lives at `archive/retired/legacy-github-pages/`

Current setup:
- public gallery reads live artwork data from `/api/artworks`
- admin page at `/admin.html`
- admin login uses GitHub Actions/Cloudflare secrets
- admin edits save artwork metadata to R2 as `artworks.json`
- admin image uploads save artwork images to R2
- email inquiry flow remains mail-based

Deploy flow:
- Pushes to `main` deploy production through GitHub Actions.
- Manual workflow dispatch can deploy `preview` or `production`.
- Local Wrangler deploy should only be used if `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are available in the shell.

Required GitHub secrets:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

Useful commands:
- `pnpm install`
- `pnpm --filter @mj-art/web build`
- `pnpm --filter @mj-art/web cf:dev`
