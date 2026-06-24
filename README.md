# Issue Kanban — a GitHub Projects v2 wrapper

A lightweight PHP front-end over a **single GitHub Projects v2 board** that gives
a cleaner Kanban view and full read/write control of issues:

- **Board view** with drag-and-drop between Status columns.
- **"My issues"** toggle (by assignee) and **team toggles** (by label/tag), combinable.
- **Sprints** via the board's Iteration field, with a sprint selector.
- **Per-person stats**: completed tasks and sprint points, scoped to a sprint.
- **Full edit**: Status, Story Points, Sprint, **labels, milestones, assignees, title/body**.
- **GitHub OAuth** login; the token stays server-side in the PHP session.
- **No database, no Composer, no build step** — drops straight onto cPanel.

All sprint/points/status data lives in **GitHub Projects v2 fields** (the source of
truth), so this app never drifts from GitHub's own UI.

---

## How it works

```
Browser  ──fetch /api/*.php──►  PHP (api/*.php)  ──Bearer token──►  GitHub API
                                  │  GraphQL: board read + Projects field writes
                                  └  REST:    labels / milestones / assignees / title-body
```

The browser only ever talks to the local `/api/*.php` endpoints; the GitHub token is
never exposed to client JavaScript.

| Path | Purpose |
|---|---|
| `public_html/index.php` | App shell + login gate |
| `public_html/api/gh.php` | Config load, session, `gql()` + `rest()` helpers, `pv2_update_field()` |
| `public_html/api/auth/*` | OAuth login / callback / logout |
| `public_html/api/me.php` | Logged-in user |
| `public_html/api/board.php` | Board fetch (fields + items, paginated) |
| `public_html/api/meta.php` | Repo labels / milestones / assignees for edit dropdowns |
| `public_html/api/move.php` | Change Status |
| `public_html/api/field.php` | Set Story Points / Sprint |
| `public_html/api/labels.php`, `milestone.php`, `assignees.php`, `issue.php` | Issue-level writes |
| `public_html/api/stats.php` | Per-person completion & points aggregation |
| `public_html/assets/app.js`, `app.css` | Front-end |

---

## Prerequisites on the board

Your Projects v2 board should use these fields (names are configurable):

- **Status** — single-select (your Kanban columns, e.g. Todo / In Progress / Done).
- **Sprint** — an **Iteration** field.
- **Story Points** — a **Number** field.
- **Teams** — GitHub **labels** on the issues (e.g. `team:frontend`); the team toggles filter by these.

---

## 1. Local testing (do this fully before deploying)

### a. Install PHP 8.x (Windows)

```powershell
winget install PHP.PHP.8.3
php -v
```

**Important:** the winget PHP build ships with **no active `php.ini`**, and this app
needs the **curl** and **openssl** extensions. Create a `php.ini` next to `php.exe`
(its folder is shown by `php --ini`) containing:

```ini
extension_dir = "C:\path\to\php\ext"
extension=curl
extension=openssl
extension=mbstring
extension=fileinfo
```

Verify with `php -m` — you should see `curl` and `openssl` listed. (On cPanel these
are enabled by default; this step is local-only.)

### b. Register a LOCAL OAuth App

GitHub → Settings → Developer settings → **OAuth Apps** → New OAuth App:

- **Homepage URL:** `http://localhost:8000`
- **Authorization callback URL:** `http://localhost:8000/api/auth/callback.php`

Copy the **Client ID** and generate a **Client Secret**.

### c. Find your Project node id

```bash
# org-owned board:
gh api graphql -f query='query($org:String!,$n:Int!){ organization(login:$org){ projectV2(number:$n){ id title } } }' -F org=YOUR_ORG -F n=PROJECT_NUMBER
# user-owned board: replace organization(login:) with user(login:)
```

The id starts with `PVT_`.

### d. Configure

Edit `public_html/config.local.php` (already present, git-ignored) with the local
Client ID/Secret and the `PVT_...` project id. Confirm the field names match your board.

### e. Run

```bash
php -S localhost:8000 -t public_html
```

Open <http://localhost:8000>, sign in with GitHub, and exercise everything
(see the Verification checklist below). Iterate until it all works — **then** deploy.

---

## 2. Deploy to cPanel (after local testing passes)

1. **Subdomain (recommended):** cPanel → Domains → create e.g. `kanban.yourdomain.com`
   with document root `public_html/kanban`. (Or use an existing site's `public_html`.)
2. **PHP version:** cPanel → MultiPHP Manager → set the domain to **PHP 8.x**.
   cPanel → Select PHP Version → Extensions: ensure **curl** and **openssl** are enabled (default).
3. **Upload the code:** cPanel → **Git Version Control** (clone this repo) *or* File Manager / FTP.
   Do **not** upload `config.php` / `config.local.php` (they're git-ignored).
4. **HTTPS:** cPanel → SSL/TLS Status → run **AutoSSL** for the (sub)domain.
   GitHub's production OAuth callback **must** be HTTPS.
5. **Production OAuth App:** create one (or add a callback) with
   `https://kanban.yourdomain.com/api/auth/callback.php`.
6. **Create `config.php` on the server** from `config.example.php` with the production
   Client ID/Secret, `OAUTH_REDIRECT` set to the HTTPS callback, and your project id.
   Set its permissions to **600**.
7. **Smoke test:** visit the site → sign in → board loads → make one edit and confirm it in GitHub.

The app auto-selects `config.local.php` on `localhost` and `config.php` everywhere else,
so the same code runs in both places without edits.

---

## Verification checklist

Run 1–7 locally first, then repeat on the deployed HTTPS URL.

1. **Auth:** sign in → redirected back, logged in.
2. **Board:** columns match your Status options; cards show title, points, labels, assignees, milestone.
3. **Filters:** "My issues" shows only your cards; team chips filter by label; they combine.
4. **Sprint:** the selector scopes the board and stats to one iteration.
5. **Status write:** drag a card to a new column → reload → persisted (check GitHub's Projects UI).
6. **Full read/write:** open a card → change Story Points, Sprint, labels, milestone, assignees, title/body → each persists in GitHub.
7. **Stats:** per-person done counts and summed points match a manual count.

---

## Notes & limits

- **Scopes:** the OAuth flow requests `project` (board) and `repo` (read+write issue
  labels/milestones/assignees/title/body). Private repos require `repo`.
- **Single board:** scoped to one `PROJECT_ID`. Items can span multiple repos; edit
  dropdowns are loaded per the card's repo.
- **No caching yet:** every load fetches from GitHub. For a large/busy board you can add
  a short-lived cache later (a small file or DB table).
