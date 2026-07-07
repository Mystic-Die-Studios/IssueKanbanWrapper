<?php
/**
 * Configuration template.
 *
 * Copy this file to:
 *   - config.local.php   for local development (callback http://localhost:8000/...)
 *   - config.php         for production       (callback https://your-domain/...)
 *
 * Both copies are git-ignored. gh.php loads config.local.php when running on
 * localhost and config.php otherwise (see config_load() in gh.php).
 *
 * HOW TO FILL THIS IN
 * -------------------
 * 1. OAuth App: GitHub -> Settings -> Developer settings -> OAuth Apps -> New.
 *    - Authorization callback URL must EXACTLY match OAUTH_REDIRECT below.
 *    - Copy the Client ID and generate a Client Secret.
 *
 * 2. PROJECT_ID: the GraphQL node id of your Projects v2 board (starts "PVT_").
 *    Find it with the gh CLI:
 *      gh api graphql -f query='
 *        query($org:String!,$n:Int!){ organization(login:$org){ projectV2(number:$n){ id title } } }
 *      ' -F org=YOUR_ORG -F n=PROJECT_NUMBER
 *    For a user-owned board, replace organization(login:) with user(login:).
 *
 * 3. Field names: must match the field names on your board exactly (case-sensitive).
 *    Status is the single-select that defines your Kanban columns.
 */

return [
    // --- OAuth ---
    'OAUTH_CLIENT_ID'     => 'your_client_id_here',
    'OAUTH_CLIENT_SECRET' => 'your_client_secret_here',

    // Must match the OAuth App's "Authorization callback URL" exactly.
    // Local:      http://localhost:8000/api/auth/callback.php
    // Production: https://kanban.yourdomain.com/api/auth/callback.php
    'OAUTH_REDIRECT'      => 'http://localhost:8000/api/auth/callback.php',

    // Scopes (space-separated):
    //   project  -> read board + move cards / edit fields
    //   repo     -> read+write issue labels/milestones/assignees/title/body
    //   read:org -> list org-owned boards (and org membership for team views)
    'OAUTH_SCOPES'        => 'project repo read:org',

    // --- Board ---
    // GraphQL node id of the Projects v2 board (starts with "PVT_").
    'PROJECT_ID'          => 'PVT_xxxxxxxxxxxx',

    // Field names exactly as they appear on the board.
    'FIELD_STATUS'        => 'Status',
    'FIELD_SPRINT'        => 'Sprint',        // an Iteration field (unused; sprints are internal)
    'FIELD_POINTS'        => 'Story Points',  // a Number field (auto-creatable if missing)
    'FIELD_START'         => 'Start date',    // a Date field (optional; shown as a range on the timeline)
    'FIELD_DUE'           => 'End date',      // a Date field used as the due date (auto-creatable if missing)

    // Which Status option counts as "done" for the stats view (case-insensitive).
    'STATUS_DONE'         => 'Done',

    // Labels beginning with this prefix are treated as "teams" and shown in a
    // separate, prominent Teams section. e.g. a label "team:frontend" becomes
    // the team "frontend". Set to '' to disable team grouping.
    'TEAM_PREFIX'         => 'team:',

    // Sprints are tracked internally (definitions in data/sprints.json) and each
    // issue's sprint membership is written as a GitHub label with this prefix,
    // e.g. assigning "Sprint 3" adds the label "sprint:Sprint 3". These labels
    // are hidden from the normal Labels filter and shown via the sprint bar.
    // (FIELD_SPRINT above is no longer used unless you switch back to an
    // Iteration field; it's kept for reference.)
    'SPRINT_PREFIX'       => 'sprint:',

    // New issues default their Milestone to this (matched by title, case-insensitive).
    // Also the target milestone for the "backfill missing milestones" action.
    // Leave '' to disable defaulting/backfill.
    'DEFAULT_MILESTONE'   => 'Phase 1',

    // The label surfaced as a prominent one-click "Help wanted" filter toggle in
    // the top bar (matched case-insensitively; also matches "help-wanted").
    'HELP_WANTED_LABEL'   => 'help wanted',

    // --- Integration bridge (server-to-server; see api/bridge.php) ---
    // A peer app (the Employee Dashboard) calls /api/bridge.php authorized by
    // this shared secret. Generate a long random value and set the SAME value as
    // KANBAN_BRIDGE_SECRET in the Dashboard's .env. Leave '' to disable the bridge.
    'BRIDGE_SECRET'        => '',

    // GitHub token (a fine-grained PAT / service account) the bridge uses to read
    // the board on behalf of dashboard requests — no user session involved. Needs
    // read access to the Projects v2 board. Leave '' to expose only the ping.
    'SERVICE_GITHUB_TOKEN' => '',
];
