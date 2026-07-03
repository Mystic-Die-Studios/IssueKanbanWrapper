<?php
/**
 * Per-person commit counts across the board's repos, for the commits/points
 * graph in the Stats view.
 *
 * GET ?sprint=<name>   (optional; omit or "all" for the whole board)
 *   When a specific sprint with dates is selected, commits are scoped to that
 *   sprint's [startDate, endDate] window. Otherwise all recent commits (bounded
 *   by a page cap per repo) are counted.
 *
 * Returns:
 *   - perPerson: [{ login, name, avatarUrl, commits }]
 *   - range:     { since, until } | null
 *   - repos:     ["owner/name", …] scanned
 *   - truncated: true if a repo hit the page cap (counts are a lower bound)
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/board.php';
require_auth();

$board = fetch_board();
$items = $board['items'];

$sprintFilter = $_GET['sprint'] ?? 'all';

// Resolve the sprint date window (if a dated sprint is selected).
$since = $until = null;
if ($sprintFilter !== 'all' && $sprintFilter !== '') {
    foreach (($board['sprints'] ?? []) as $s) {
        if (($s['name'] ?? null) === $sprintFilter) {
            if (!empty($s['startDate'])) $since = $s['startDate'] . 'T00:00:00Z';
            if (!empty($s['endDate']))   $until = $s['endDate'] . 'T23:59:59Z';
            break;
        }
    }
}

// Unique repos referenced by board items.
$repos = [];
foreach ($items as $it) {
    $r = $it['repo'] ?? null;
    if ($r) $repos[$r] = true;
}
$repos = array_keys($repos);

$MAX_PAGES = 3;   // per repo (100 commits/page) — bounds a very active repo
$people    = [];  // login => { login, name, avatarUrl, commits }
$truncated = false;

foreach ($repos as $repo) {
    for ($page = 1; $page <= $MAX_PAGES; $page++) {
        $q = ['per_page' => '100', 'page' => (string) $page];
        if ($since) $q['since'] = $since;
        if ($until) $q['until'] = $until;
        $path = "/repos/{$repo}/commits?" . http_build_query($q);

        [$code, $body] = rest('GET', $path);
        if ($code >= 400 || !is_array($body)) {
            break; // repo may be empty / inaccessible — skip quietly
        }
        foreach ($body as $c) {
            // Prefer the linked GitHub user; fall back to the raw commit author.
            $login  = $c['author']['login'] ?? null;
            $avatar = $c['author']['avatar_url'] ?? null;
            $name   = $c['commit']['author']['name'] ?? null;
            $key    = $login ?: ($name ?: '(unknown)');
            if (!isset($people[$key])) {
                $people[$key] = [
                    'login'     => $login ?: $key,
                    'name'      => $name,
                    'avatarUrl' => $avatar,
                    'commits'   => 0,
                ];
            }
            if (!$people[$key]['avatarUrl'] && $avatar) $people[$key]['avatarUrl'] = $avatar;
            $people[$key]['commits']++;
        }
        if (count($body) < 100) break;          // last page
        if ($page === $MAX_PAGES) $truncated = true;
    }
}

$perPerson = array_values($people);
usort($perPerson, fn ($a, $b) => $b['commits'] <=> $a['commits']);

json_out([
    'scope'     => $sprintFilter,
    'range'     => ($since || $until) ? ['since' => $since, 'until' => $until] : null,
    'repos'     => $repos,
    'truncated' => $truncated,
    'perPerson' => $perPerson,
]);
