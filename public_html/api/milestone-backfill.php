<?php
/**
 * Assign the configured DEFAULT_MILESTONE (e.g. "Phase 1") to every OPEN board
 * issue that currently has no milestone. Bulk, one-time hygiene action.
 *
 * GET  -> preview: how many issues would change, and which repos are missing the
 *         milestone entirely. Does NOT write.
 * POST -> perform the backfill.
 *
 * Returns: { milestone, updated, skippedNoMilestone, missingRepos: [...], total }
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/board.php';
require_auth();

$target = trim((string) config('DEFAULT_MILESTONE', ''));
if ($target === '') {
    json_error('DEFAULT_MILESTONE is not configured', 400);
}

$board = fetch_board();
$items = $board['items'];

// Candidate issues: real, open issues on the board with no milestone.
$candidates = [];
$repos = [];
foreach ($items as $it) {
    if (empty($it['repo']) || empty($it['number'])) continue;
    if (strtoupper((string) ($it['state'] ?? '')) === 'CLOSED') continue;
    if (!empty($it['milestone'])) continue;
    $candidates[] = ['repo' => $it['repo'], 'number' => (int) $it['number']];
    $repos[$it['repo']] = true;
}

// Resolve the target milestone NUMBER per repo (by title, case-insensitive).
$milestoneByRepo = [];  // repo => number
$missingRepos    = [];
foreach (array_keys($repos) as $repo) {
    $num = null;
    for ($page = 1; $page <= 5; $page++) {
        [$code, $body] = rest('GET', "/repos/{$repo}/milestones?state=all&per_page=100&page={$page}");
        if ($code >= 400 || !is_array($body) || !$body) break;
        foreach ($body as $m) {
            if (strcasecmp((string) ($m['title'] ?? ''), $target) === 0) { $num = (int) $m['number']; break 2; }
        }
        if (count($body) < 100) break;
    }
    if ($num === null) $missingRepos[] = $repo;
    else $milestoneByRepo[$repo] = $num;
}

$preview = ($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST';

$updated = 0;
$skipped = 0;
foreach ($candidates as $c) {
    if (!isset($milestoneByRepo[$c['repo']])) { $skipped++; continue; } // repo has no such milestone
    if ($preview) { $updated++; continue; }
    [$code, $body] = rest('PATCH', "/repos/{$c['repo']}/issues/{$c['number']}",
        ['milestone' => $milestoneByRepo[$c['repo']]]);
    if ($code >= 400) { $skipped++; continue; }
    $updated++;
}

json_out([
    'ok'                 => true,
    'preview'            => $preview,
    'milestone'          => $target,
    'updated'            => $updated,             // (would-be count when preview)
    'skippedNoMilestone' => $skipped,
    'missingRepos'       => $missingRepos,
    'total'              => count($candidates),
]);
