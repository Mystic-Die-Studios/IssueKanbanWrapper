<?php
/**
 * Tiny JSON-file storage for sprint definitions, keyed by project id.
 * File lives under public_html/data/ and is blocked from the web by .htaccess.
 *
 * Data shape:
 *   { "<PROJECT_ID>": {
 *       "sprints":   [ {name, startDate, endDate, archived?}, ... ],
 *       "archives":  [ {id, sprint, startDate, endDate, archivedAt, completedPoints,
 *                       cancelledPoints, issues:[{repo, number, title, points, url, assignees}]}, ... ],
 *       "timelineMilestones": [ {id, title, date, color}, ... ]
 *   } }
 *
 * Issue->sprint membership is NOT stored here — it's derived from each issue's
 * due date (the sprint whose date window contains it; see sprint_for_date()).
 * This file holds sprint metadata, archived sprint records (finished issues and
 * points saved by the site) and the Timeline's milestone markers.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';

function sprint_data_dir(): string
{
    $dir = dirname(__DIR__) . '/data'; // public_html/data
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
        // Belt-and-suspenders: drop a deny file even if the repo one is missing.
        @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
    }
    return $dir;
}

function sprint_store_file(): string
{
    return sprint_data_dir() . '/sprints.json';
}

/** Read one list-valued key (sprints, snapshots, …) for a project (no lock — read-only callers). */
function store_list_get(string $projectId, string $key): array
{
    $f = sprint_store_file();
    if (!is_file($f)) {
        return [];
    }
    $all = json_decode((string) file_get_contents($f), true);
    if (!is_array($all)) {
        return [];
    }
    return $all[$projectId][$key] ?? [];
}

/**
 * Read-modify-write one list-valued key for a project under an exclusive lock,
 * leaving sibling keys untouched. $fn receives the current list and must return
 * the new one. Returns the new list.
 *
 * With $soft, a storage failure returns null instead of aborting the request —
 * for best-effort background writes (sprint auto-creation) that must never
 * take the board down with them.
 */
function store_list_mutate(string $projectId, string $key, callable $fn, bool $soft = false): ?array
{
    $f = sprint_store_file();
    $fp = @fopen($f, 'c+');
    if (!$fp) {
        if ($soft) {
            return null;
        }
        json_error('Unable to open sprint storage for writing', 500);
    }
    flock($fp, LOCK_EX);

    $raw = stream_get_contents($fp);
    $all = json_decode((string) $raw, true);
    if (!is_array($all)) {
        $all = [];
    }
    $current = $all[$projectId][$key] ?? [];

    // NB: $fn may call json_error() (which exits). That happens before we
    // truncate/write below, so the file is left intact and the lock is released
    // on process shutdown.
    $new = array_values($fn($current));

    $all[$projectId][$key] = $new;
    rewind($fp);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    return $new;
}

/** Read the sprints array for a project (no lock — read-only callers). */
function sprints_get(string $projectId): array
{
    return store_list_get($projectId, 'sprints');
}

/**
 * Read-modify-write the sprints for a project under an exclusive lock.
 * $fn receives the current sprints array and must return the new one.
 * Returns the new sprints array.
 */
function sprints_mutate(string $projectId, callable $fn): array
{
    return store_list_mutate($projectId, 'sprints', $fn);
}

// ---- sprint cadence -------------------------------------------------------
// Sprints run a fixed 2-week cadence, Monday through Sunday. New ones are
// created automatically (on board load) after the latest defined sprint, so a
// board that nobody opened for a few weeks backfills the missed sprints.

const SPRINT_LENGTH_DAYS = 14;

/**
 * The sprints that must be appended to $sprints so that sprints exist through
 * the one AFTER the sprint containing $today (one sprint of lookahead, so work
 * can be planned / rolled over into it before it starts). Pure — no I/O.
 *
 * Each new sprint starts on the Monday after the latest existing sprint ends
 * (or this week's Monday when there are none) and is named "Sprint N",
 * continuing the highest existing "Sprint N" number.
 */
function sprints_plan_missing(array $sprints, DateTimeImmutable $today): array
{
    $latestEnd = null;
    $maxNum    = 0;
    $taken     = [];
    foreach ($sprints as $s) {
        $name = (string) ($s['name'] ?? '');
        $taken[strtolower($name)] = true;
        if (preg_match('/^sprint\s+(\d+)/i', $name, $m)) {
            $maxNum = max($maxNum, (int) $m[1]);
        }
        $end = $s['endDate'] ?? null;
        if (is_string($end) && preg_match('/^\d{4}-\d{2}-\d{2}$/', $end) && ($latestEnd === null || $end > $latestEnd)) {
            $latestEnd = $end;
        }
    }
    if ($maxNum === 0) {
        $maxNum = count($sprints);
    }

    $today = $today->setTime(0, 0);
    $start = $latestEnd !== null
        ? (new DateTimeImmutable($latestEnd))->modify('+1 day')
        : $today->modify('monday this week');
    if ((int) $start->format('N') !== 1) {
        $start = $start->modify('next monday');
    }
    $horizon = $today->modify('+' . SPRINT_LENGTH_DAYS . ' days');

    $new = [];
    while ($start <= $horizon) {
        do {
            $name = 'Sprint ' . (++$maxNum);
        } while (isset($taken[strtolower($name)]));
        $taken[strtolower($name)] = true;
        $new[] = [
            'name'      => $name,
            'startDate' => $start->format('Y-m-d'),
            'endDate'   => $start->modify('+' . (SPRINT_LENGTH_DAYS - 1) . ' days')->format('Y-m-d'),
        ];
        $start = $start->modify('+' . SPRINT_LENGTH_DAYS . ' days');
    }
    return $new;
}

/**
 * Create any sprints the cadence says should exist by now. Idempotent and
 * best-effort: a lock-free check skips the write when nothing is missing, and
 * a storage failure is ignored rather than breaking the caller.
 */
function sprints_autofill(string $projectId, ?DateTimeImmutable $today = null): void
{
    $today = $today ?? new DateTimeImmutable('today');
    if (!sprints_plan_missing(sprints_get($projectId), $today)) {
        return;
    }
    // Re-plan under the lock so two concurrent loads can't both append.
    store_list_mutate($projectId, 'sprints', function (array $cur) use ($today) {
        return array_merge($cur, sprints_plan_missing($cur, $today));
    }, true);
}

/**
 * The name of the sprint a due date falls in (inclusive of both ends), or null.
 * If sprints overlap, the one that started most recently wins. Mirrored by
 * sprintForDate() in app.js — keep the two in sync.
 */
function sprint_for_date(array $sprints, ?string $date): ?string
{
    if (!$date) {
        return null;
    }
    $best = null;
    foreach ($sprints as $s) {
        $a = $s['startDate'] ?? null;
        $b = $s['endDate'] ?? null;
        if (!$a || !$b || $date < $a || $date > $b) {
            continue;
        }
        if ($best === null || $a > $best['startDate']) {
            $best = $s;
        }
    }
    return $best['name'] ?? null;
}

/** Sprints still shown on the board (archived ones are kept in the store but hidden). */
function sprints_visible(array $sprints): array
{
    return array_values(array_filter($sprints, fn($s) => empty($s['archived'])));
}

/** Archived sprint records (finished issues + points, kept by the site). */
function archives_get(string $projectId): array
{
    return store_list_get($projectId, 'archives');
}

/** "owner/repo#number" keys of every issue saved in an archive (hidden from the board). */
function archived_issue_keys(array $archives): array
{
    $keys = [];
    foreach ($archives as $a) {
        foreach (($a['issues'] ?? []) as $i) {
            if (!empty($i['repo']) && isset($i['number'])) {
                $keys[$i['repo'] . '#' . $i['number']] = true;
            }
        }
    }
    return $keys;
}

/** Timeline milestones (website-only date markers) for a project. */
function timeline_milestones_get(string $projectId): array
{
    return store_list_get($projectId, 'timelineMilestones');
}

/**
 * Read the roster for a project (read-only, no lock).
 * Shape: { people: { "<login>": <weeklyHours> }, manual: { "<team>": [ {name, hours} ] } }
 * `people` are GitHub logins; `manual` are extra non-GitHub members per team.
 */
function roster_get(string $projectId): array
{
    $f = sprint_store_file();
    $default = ['people' => (object) [], 'manual' => (object) [], 'hoursPerPoint' => 0];
    if (!is_file($f)) {
        return $default;
    }
    $all = json_decode((string) file_get_contents($f), true);
    if (!is_array($all)) {
        return $default;
    }
    $r = $all[$projectId]['roster'] ?? [];
    return [
        'people'        => $r['people'] ?? (object) [],
        'manual'        => $r['manual'] ?? (object) [],
        'hoursPerPoint' => isset($r['hoursPerPoint']) ? (float) $r['hoursPerPoint'] : 0,
        // Manual team-membership overrides on top of the derived (assignee-based)
        // membership: teamAdd forces someone in, teamRemove forces someone out.
        'teamAdd'       => $r['teamAdd'] ?? (object) [],
        'teamRemove'    => $r['teamRemove'] ?? (object) [],
    ];
}

/**
 * Read-modify-write the roster for a project under an exclusive lock.
 * $fn receives the current roster (assoc array with 'people' and 'manual') and
 * must return the new one. Preserves sibling keys (sprints, snapshots).
 */
function roster_mutate(string $projectId, callable $fn): array
{
    $f = sprint_store_file();
    $fp = fopen($f, 'c+');
    if (!$fp) {
        json_error('Unable to open roster storage for writing', 500);
    }
    flock($fp, LOCK_EX);

    $raw = stream_get_contents($fp);
    $all = json_decode((string) $raw, true);
    if (!is_array($all)) {
        $all = [];
    }
    $current = $all[$projectId]['roster'] ?? ['people' => [], 'manual' => []];
    if (!isset($current['people']) || !is_array($current['people'])) $current['people'] = [];
    if (!isset($current['manual']) || !is_array($current['manual'])) $current['manual'] = [];

    $new = $fn($current);

    $all[$projectId]['roster'] = $new;
    rewind($fp);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    return $new;
}
