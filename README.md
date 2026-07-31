# MJ Art Site

MJ-ART deploys exclusively through GitHub Actions. Cloudflare credentials are GitHub Actions secrets and are not expected in the local shell. Read docs/OPERATIONS.md before proposing deployment, Cloudflare, Wrangler, or R2 work.

See [docs/OPERATIONS.md](docs/OPERATIONS.md) for the full operations, deployment, and R2 backup policy.

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
- Pushes to `main` and pull requests run checks only through GitHub Actions; no deployment is triggered.
- Manual workflow dispatch deploys the selected `preview` (default) or `production` environment.
- Local deploy is prohibited. The `wrangler deploy` / `cf:deploy*` scripts in `apps/web` are CI implementation details used by the GitHub Actions workflow and must not be run from a local terminal. See [docs/OPERATIONS.md](docs/OPERATIONS.md).

Required GitHub secrets:
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

Useful commands:
- `pnpm install`
- `pnpm --filter @mj-art/web build`
- `pnpm --filter @mj-art/web cf:dev`
