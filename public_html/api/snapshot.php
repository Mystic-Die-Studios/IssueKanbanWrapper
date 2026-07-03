<?php
/**
 * Website-only sprint snapshots (frozen copies of pushed issues).
 *
 * POST { op: "add", snapshot: { sprint, repo, number, title, points,
 *        url, assignees:[...], pushedTo } }   -> creates one, returns snapshots
 * POST { op: "delete", id }                    -> removes one, returns snapshots
 *
 * Snapshots never touch GitHub; they only live in data/sprints.json so the
 * closed sprint keeps a record of what was rolled forward.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/store.php';
require_auth();

$in  = json_input();
$op  = $in['op'] ?? '';
$pid = config('PROJECT_ID');

if ($op === 'add') {
    $s = $in['snapshot'] ?? null;
    if (!is_array($s) || empty($s['sprint'])) {
        json_error("'snapshot' with at least a 'sprint' is required", 400);
    }
    $snap = [
        'id'        => bin2hex(random_bytes(8)),
        'sprint'    => (string) $s['sprint'],
        'repo'      => (string) ($s['repo'] ?? ''),
        'number'    => isset($s['number']) ? (int) $s['number'] : null,
        'title'     => (string) ($s['title'] ?? '(untitled)'),
        'points'    => isset($s['points']) && $s['points'] !== null ? (float) $s['points'] : null,
        'url'       => (string) ($s['url'] ?? ''),
        'assignees' => array_map(function ($a) {
            return [
                'login'     => (string) ($a['login'] ?? ''),
                'name'      => $a['name'] ?? null,
                'avatarUrl' => $a['avatarUrl'] ?? null,
            ];
        }, is_array($s['assignees'] ?? null) ? $s['assignees'] : []),
        'pushedTo'  => $s['pushedTo'] ?? null,
        'createdAt' => date('c'),
    ];
    $snaps = snapshots_mutate($pid, function ($cur) use ($snap) {
        $cur[] = $snap;
        return $cur;
    });
    json_out(['ok' => true, 'snapshot' => $snap, 'snapshots' => $snaps]);
}

if ($op === 'delete') {
    $id = (string) ($in['id'] ?? '');
    if ($id === '') {
        json_error("'id' is required", 400);
    }
    $snaps = snapshots_mutate($pid, function ($cur) use ($id) {
        return array_filter($cur, fn ($s) => ($s['id'] ?? '') !== $id);
    });
    json_out(['ok' => true, 'snapshots' => $snaps]);
}

json_error("Unknown op '$op' (use add | delete)", 400);
