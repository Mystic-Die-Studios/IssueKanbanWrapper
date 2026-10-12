<?php
/**
 * Archive an old sprint.
 *
 * POST { op: "archive", sprint, finished: [ {repo, number, title, points, url, assignees} ],
 *        cancelled: [ {issueId, itemId, type, points} ] }
 *   - Cancelled issues are permanently deleted from GitHub.
 *   - Finished issues + the sprint's points are saved in the site's records
 *     (data/sprints.json) and hidden from the board.
 *   - The sprint itself is flagged archived (kept so the cadence stays intact).
 * POST { op: "delete", id }  -> remove an archive record (finished issues reappear on the board)
 *
 * Responds with { ok, archives, sprints, failed: [...] }.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/store.php';
require_auth();

$in  = json_input();
$op  = $in['op'] ?? '';
$pid = config('PROJECT_ID');

if ($op === 'delete') {
    $id = (string) ($in['id'] ?? '');
    if ($id === '') {
        json_error("'id' is required", 400);
    }
    $archives = store_list_mutate($pid, 'archives', function ($cur) use ($id) {
        return array_filter($cur, fn($a) => ($a['id'] ?? '') !== $id);
    });
    json_out(['ok' => true, 'archives' => $archives]);
}

if ($op !== 'archive') {
    json_error("Unknown op '$op' (use archive | delete)", 400);
}

$name = trim((string) ($in['sprint'] ?? ''));
$sprint = null;
foreach (sprints_get($pid) as $s) {
    if (strcasecmp($s['name'], $name) === 0) {
        $sprint = $s;
    }
}
if (!$sprint) {
    json_error("Sprint '$name' not found", 404);
}

// Delete the cancelled issues first; any that fail are reported and left alone.
$cancelledPoints = 0.0;
$failed = [];
foreach ((is_array($in['cancelled'] ?? null) ? $in['cancelled'] : []) as $c) {
    $errs = delete_board_card((string) ($c['issueId'] ?? ''), (string) ($c['itemId'] ?? ''), (string) ($c['type'] ?? ''));
    if ($errs) {
        $failed[] = $c['title'] ?? ($c['issueId'] ?? '?');
    } else {
        $cancelledPoints += (float) ($c['points'] ?? 0);
    }
}

$issues = [];
$completedPoints = 0.0;
foreach ((is_array($in['finished'] ?? null) ? $in['finished'] : []) as $f) {
    $pts = isset($f['points']) && $f['points'] !== null ? (float) $f['points'] : null;
    $completedPoints += $pts ?? 0;
    $issues[] = [
        'repo'      => (string) ($f['repo'] ?? ''),
        'number'    => isset($f['number']) ? (int) $f['number'] : null,
        'title'     => (string) ($f['title'] ?? '(untitled)'),
        'points'    => $pts,
        'url'       => (string) ($f['url'] ?? ''),
        'assignees' => array_map(fn($a) => [
            'login'     => (string) ($a['login'] ?? ''),
            'name'      => $a['name'] ?? null,
            'avatarUrl' => $a['avatarUrl'] ?? null,
        ], is_array($f['assignees'] ?? null) ? $f['assignees'] : []),
    ];
}

$record = [
    'id'              => bin2hex(random_bytes(8)),
    'sprint'          => $sprint['name'],
    'startDate'       => $sprint['startDate'] ?? null,
    'endDate'         => $sprint['endDate'] ?? null,
    'archivedAt'      => date('c'),
    'completedPoints' => $completedPoints,
    'cancelledPoints' => $cancelledPoints,
    'issues'          => $issues,
];
$archives = store_list_mutate($pid, 'archives', function ($cur) use ($record) {
    $cur[] = $record;
    return $cur;
});

$sprints = sprints_mutate($pid, function ($cur) use ($sprint) {
    foreach ($cur as &$s) {
        if (strcasecmp($s['name'], $sprint['name']) === 0) {
            $s['archived'] = true;
        }
    }
    unset($s);
    return $cur;
});

json_out([
    'ok'        => true,
    'archives'  => $archives,
    'sprints'   => sprints_visible($sprints),
    'failed'    => $failed,
]);
