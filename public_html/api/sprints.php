<?php
/**
 * Sprint definitions CRUD (stored locally, keyed by project id).
 *
 *   GET  /api/sprints.php                     -> { sprints: [...] }
 *   POST /api/sprints.php { op: "create", name, startDate?, endDate? }
 *   POST /api/sprints.php { op: "update", name, startDate?, endDate?, closed? }
 *   POST /api/sprints.php { op: "delete", name }
 *
 * Sprint identity is its (case-insensitive) name, because membership is stored
 * as a GitHub label "sprint:<name>". Renaming is therefore not supported here
 * (it would orphan existing labels) — delete + recreate instead.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/store.php';
require_auth();

$projectId = config('PROJECT_ID');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    json_out(['sprints' => sprints_get($projectId)]);
}

$in = json_input();
$op = $in['op'] ?? '';

switch ($op) {
    case 'create':
        $name = trim((string) ($in['name'] ?? ''));
        if ($name === '') {
            json_error('Sprint name is required', 400);
        }
        $sprints = sprints_mutate($projectId, function (array $cur) use ($name, $in) {
            foreach ($cur as $s) {
                if (strcasecmp($s['name'], $name) === 0) {
                    json_error("A sprint named '$name' already exists", 409);
                }
            }
            $cur[] = [
                'name'      => $name,
                'startDate' => $in['startDate'] ?? null,
                'endDate'   => $in['endDate'] ?? null,
                'closed'    => false,
            ];
            return $cur;
        });
        json_out(['ok' => true, 'sprints' => $sprints]);
        // no break needed; json_out exits

    case 'update':
        $name = (string) ($in['name'] ?? '');
        $sprints = sprints_mutate($projectId, function (array $cur) use ($name, $in) {
            $found = false;
            foreach ($cur as &$s) {
                if (strcasecmp($s['name'], $name) === 0) {
                    if (array_key_exists('startDate', $in)) $s['startDate'] = $in['startDate'];
                    if (array_key_exists('endDate', $in))   $s['endDate']   = $in['endDate'];
                    if (array_key_exists('closed', $in))    $s['closed']    = (bool) $in['closed'];
                    $found = true;
                }
            }
            unset($s);
            if (!$found) {
                json_error("Sprint '$name' not found", 404);
            }
            return $cur;
        });
        json_out(['ok' => true, 'sprints' => $sprints]);

    case 'delete':
        $name = (string) ($in['name'] ?? '');
        $sprints = sprints_mutate($projectId, function (array $cur) use ($name) {
            return array_filter($cur, fn($s) => strcasecmp($s['name'], $name) !== 0);
        });
        json_out(['ok' => true, 'sprints' => $sprints]);

    default:
        json_error("Unknown op '$op'", 400);
}
