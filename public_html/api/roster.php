<?php
/**
 * Team roster: per-person expected weekly hours, plus extra "not in git"
 * members per team. Drives each sprint's target velocity (capacity).
 *
 * GET  -> returns the roster { people:{login:hours}, manual:{team:[{name,hours}]} }
 * POST { op:"setPersonHours",   login, hours }          -> set a person's weekly hours
 * POST { op:"setTeamExtra",     team, entries:[{name,hours}] } -> replace a team's manual list
 * POST { op:"setHoursPerPoint", value }                 -> hours-per-point (for velocity)
 *
 * Stored in data/sprints.json (git-ignored) alongside sprints/snapshots.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/store.php';
require_auth();

$pid = config('PROJECT_ID');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    json_out(['ok' => true, 'roster' => roster_get($pid)]);
}

$in = json_input();
$op = $in['op'] ?? '';

// Clamp hours to a sane, non-negative range.
$clampHours = function ($v): float {
    $n = is_numeric($v) ? (float) $v : 0.0;
    if ($n < 0) $n = 0.0;
    if ($n > 168) $n = 168.0; // hours in a week
    return round($n, 1);
};

if ($op === 'setPersonHours') {
    $login = trim((string) ($in['login'] ?? ''));
    if ($login === '') json_error("'login' is required", 400);
    $hours = $clampHours($in['hours'] ?? 0);
    $roster = roster_mutate($pid, function ($r) use ($login, $hours) {
        if ($hours <= 0) unset($r['people'][$login]);
        else $r['people'][$login] = $hours;
        return $r;
    });
    json_out(['ok' => true, 'roster' => $roster]);
}

if ($op === 'setTeamExtra') {
    $team = trim((string) ($in['team'] ?? ''));
    if ($team === '') json_error("'team' is required", 400);
    $entriesIn = is_array($in['entries'] ?? null) ? $in['entries'] : [];
    $entries = [];
    foreach ($entriesIn as $e) {
        $name = trim((string) ($e['name'] ?? ''));
        if ($name === '') continue;
        $entries[] = ['name' => $name, 'hours' => $clampHours($e['hours'] ?? 0)];
    }
    $roster = roster_mutate($pid, function ($r) use ($team, $entries) {
        if (!$entries) unset($r['manual'][$team]);
        else $r['manual'][$team] = $entries;
        return $r;
    });
    json_out(['ok' => true, 'roster' => $roster]);
}

if ($op === 'setHoursPerPoint') {
    $v = is_numeric($in['value'] ?? null) ? (float) $in['value'] : 0.0;
    if ($v < 0) $v = 0.0;
    $v = round($v, 2);
    $roster = roster_mutate($pid, function ($r) use ($v) {
        $r['hoursPerPoint'] = $v;
        return $r;
    });
    json_out(['ok' => true, 'roster' => $roster]);
}

json_error("Unknown op '$op'", 400);
