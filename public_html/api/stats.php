<?php
/**
 * Per-person completion & sprint-points aggregation, computed from the board.
 *
 * GET ?sprint=<iterationId>   (optional; omit or "all" for the whole board)
 *
 * Returns, for the selected scope:
 *   - perPerson: [{ login, avatarUrl, doneCount, donePoints, openCount, openPoints, totalPoints }]
 *   - totals:    { doneCount, donePoints, openCount, openPoints, totalItems }
 *   - sprints:   the available iterations (for the selector)
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/board.php';
require_auth();

$board   = fetch_board();
$cfg     = $board['config'];
$items   = $board['items'];

$statusField = $cfg['statusField'];
$pointsField = $cfg['pointsField'];
$doneName    = strtolower((string) $cfg['statusDone']);

// Sprint scope is an internal sprint NAME (or 'all').
$sprintFilter = $_GET['sprint'] ?? 'all';

// Available sprints (for the UI selector), from internal storage.
$sprints = $board['sprints'] ?? [];

$people = []; // login => row
$totals = ['doneCount' => 0, 'donePoints' => 0.0, 'openCount' => 0, 'openPoints' => 0.0, 'totalItems' => 0];

foreach ($items as $it) {
    // Scope to selected sprint (matched by name via the item's sprint label).
    if ($sprintFilter !== 'all' && $sprintFilter !== '') {
        if (($it['sprint'] ?? null) !== $sprintFilter) {
            continue;
        }
    }

    $statusName = strtolower((string) ($it['fields'][$statusField]['name'] ?? ''));
    $isDone     = ($statusName === $doneName);
    $points     = (float) ($it['fields'][$pointsField]['number'] ?? 0);

    $totals['totalItems']++;
    if ($isDone) {
        $totals['doneCount']++;
        $totals['donePoints'] += $points;
    } else {
        $totals['openCount']++;
        $totals['openPoints'] += $points;
    }

    // Attribute to each assignee (unassigned bucketed under "(unassigned)").
    $assignees = $it['assignees'] ?: [['login' => '(unassigned)', 'avatarUrl' => null]];
    foreach ($assignees as $a) {
        $login = $a['login'];
        if (!isset($people[$login])) {
            $people[$login] = [
                'login'       => $login,
                'avatarUrl'   => $a['avatarUrl'] ?? null,
                'doneCount'   => 0,
                'donePoints'  => 0.0,
                'openCount'   => 0,
                'openPoints'  => 0.0,
                'totalPoints' => 0.0,
            ];
        }
        if ($isDone) {
            $people[$login]['doneCount']++;
            $people[$login]['donePoints'] += $points;
        } else {
            $people[$login]['openCount']++;
            $people[$login]['openPoints'] += $points;
        }
        $people[$login]['totalPoints'] += $points;
    }
}

// Sort by completed points desc, then done count.
$perPerson = array_values($people);
usort($perPerson, function ($a, $b) {
    return [$b['donePoints'], $b['doneCount']] <=> [$a['donePoints'], $a['doneCount']];
});

json_out([
    'scope'     => $sprintFilter,
    'sprints'   => $sprints,
    'perPerson' => $perPerson,
    'totals'    => $totals,
]);
