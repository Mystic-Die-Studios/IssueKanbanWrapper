# Deploying to cPanel (Git Version Control + subdomain)

This guide is tailored to **Mystic-Die-Studios/IssueKanbanWrapper** deployed to a
new subdomain via cPanel's Git Version Control. Replace `kanban.yourdomain.com`
with your actual host everywhere below.

Prerequisites: cPanel with PHP 8.1+, "Git Version Control", "SSH Access", and AutoSSL.

---

## 1. Create the subdomain
cPanel → **Domains → Create a New Domain** → `kanban.yourdomain.com`.
Leave the document root for now; we'll point it at the app in step 4.

## 2. Give cPanel read access to the private repo (deploy key)
Because the repo is private, cPanel needs an SSH key GitHub trusts:
1. cPanel → **SSH Access → Manage SSH Keys → Generate a New Key** (RSA, no passphrase). 
2. Under **Public Keys**, click **View/Download** and copy the public key text.
3. GitHub → repo **Settings → Deploy keys → Add deploy key** → paste it (read-only is fine).
4. Back in cPanel SSH Keys, **Manage → Authorize** the key (so the server uses it).

## 3. Clone the repo
cPanel → **Git Version Control → Create**:
- **Clone URL:** `git@github.com:Mystic-Die-Studios/IssueKanbanWrapper.git`
- **Repository Path:** e.g. `/home/USER/repositories/IssueKanbanWrapper`

Create → cPanel clones the repo. (USER = your cPanel username.)

## 4. Point the subdomain at the app's `public_html`
The web files live in the repo's `public_html/` subfolder. 
cPanel → **Domains** → manage `kanban.yourdomain.com` → set **Document Root** to:

```
/home/USER/repositories/IssueKanbanWrapper/public_html
```

## 5. PHP version + extensions
- cPanel → **MultiPHP Manager** → set the subdomain to **PHP 8.1+**.
- cPanel → **Select PHP Version → Extensions** → ensure **curl** and **openssl** are enabled (default).

## 6. HTTPS
cPanel → **SSL/TLS Status** → run **AutoSSL** for the subdomain. Confirm `https://` loads.
(GitHub OAuth requires an HTTPS callback.)

## 7. Production GitHub OAuth App
GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**:
- **Homepage URL:** `https://kanban.yourdomain.com`
- **Authorization callback URL:** `https://kanban.yourdomain.com/api/auth/callback.php`

Copy the **Client ID** and generate a **Client Secret**.
(OAuth Apps allow only one callback URL, so this is a separate app from your local one.)

## 8. Create `config.php` on the server
In **File Manager**, open the docroot (`…/IssueKanbanWrapper/public_html`), copy
`config.example.php` → `config.php`, and set its contents to (already filled with
this project's board values — just add the OAuth lines and your host):

```php
<?php
return [
    'OAUTH_CLIENT_ID'     => 'PROD_CLIENT_ID',
    'OAUTH_CLIENT_SECRET' => 'PROD_CLIENT_SECRET',
    'OAUTH_REDIRECT'      => 'https://kanban.yourdomain.com/api/auth/callback.php',
    'OAUTH_SCOPES'        => 'project repo read:org',

    'PROJECT_ID'          => 'PVT_kwDOERzVNM4BZjuu',

    'FIELD_STATUS'        => 'Status',
    'FIELD_POINTS'        => 'Estimate',     // your board's number field
    'FIELD_START'         => 'Start date',
    'FIELD_DUE'           => 'Target date',
    'STATUS_DONE'         => 'Done',         // set to your "completed" column name
    'TEAM_PREFIX'         => 'team:',
    'SPRINT_PREFIX'       => 'sprint:',
];
```

Then set `config.php` permissions to **600** (File Manager → right-click → Change Permissions).

## 9. Verify the data directory is writable
Sprints are stored in `public_html/data/sprints.json`. The `data/` folder ships with a
`.htaccess` that blocks web access; PHP (running as your cPanel user) can write to it by
default. If sprint creation fails, set `public_html/data` to permissions **755** (or 775).

## 10. Test
Visit `https://kanban.yourdomain.com` → **Sign in with GitHub** → the board loads.
Make one edit and confirm it appears in GitHub.

---

## Updating later
cPanel → **Git Version Control → Manage → Update from Remote / Pull**.
`config.php` and `data/*.json` are git-ignored, so pulls never overwrite them.

## Troubleshooting
- **Blank page / 500:** check `public_html`'s PHP error log (cPanel → Errors), confirm PHP 8.1+ and curl/openssl.
- **SSL "unable to get local issuer certificate":** only a local-dev issue; cPanel has a CA bundle.
- **OAuth redirect mismatch:** the callback in the OAuth App must exactly equal `OAUTH_REDIRECT`.
- **Org board not visible:** the org's OAuth app access policy may need approval (org → Settings → Third-party Access).
