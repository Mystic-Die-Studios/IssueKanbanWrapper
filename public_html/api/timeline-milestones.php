<?php
/**
 * Timeline milestones: website-only date markers ("Alpha", "Launch", …) drawn
 * as vertical lines down the whole Timeline calendar. Stored in
 * data/sprints.json — unrelated to GitHub's per-repo issue milestones.
 *
 *   GET                                               -> { milestones: [...] }
 *   POST { op: "create", title, date, color? }        -> { ok, milestones }
 *   POST { op: "update", id, title?, date?, color? }  -> { ok, milestones }
 *   POST { op: "delete", id }                         -> { ok, milestones }
 *
 * Milestone shape: { id, title, date: "YYYY-MM-DD", color: "rrggbb" }
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/store.php';
require_auth();

$pid = config('PROJECT_ID');

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'GET') {
    json_out(['milestones' => timeline_milestones_get($pid)]);
}

$in = json_input();
$op = $in['op'] ?? '';

$cleanTitle = function ($v): string {
    $t = trim((string) $v);
    if ($t === '') {
        json_error('Milestone title is required', 400);
    }
    preg_match('/^.{1,80}/su', $t, $m); // cap length without splitting a UTF-8 char
    return $m[0] ?? $t;
};
$cleanDate = function ($v): string {
    $d  = (string) $v;
    $dt = DateTimeImmutable::createFromFormat('!Y-m-d', $d);
    if (!$dt || $dt->format('Y-m-d') !== $d) {
        json_error("'date' must be YYYY-MM-DD", 400);
    }
    return $d;
};
// Stored without '#'; anything that isn't a 6-digit hex falls back to amber.
$cleanColor = function ($v): string {
    $c = ltrim(strtolower(trim((string) $v)), '#');
    return preg_match('/^[0-9a-f]{6}$/', $c) ? $c : 'f0b429';
};
$byDate = function (array $list): array {
    usort($list, fn ($a, $b) => [$a['date'], $a['title']] <=> [$b['date'], $b['title']]);
    return $list;
};

switch ($op) {
    case 'create':
        $ms = [
            'id'    => bin2hex(random_bytes(8)),
            'title' => $cleanTitle($in['title'] ?? ''),
            'date'  => $cleanDate($in['date'] ?? ''),
            'color' => $cleanColor($in['color'] ?? ''),
        ];
        $list = store_list_mutate($pid, 'timelineMilestones', function (array $cur) use ($ms, $byDate) {
            $cur[] = $ms;
            return $byDate($cur);
        });
        json_out(['ok' => true, 'milestones' => $list]);

    case 'update':
        $id = (string) ($in['id'] ?? '');
        $list = store_list_mutate($pid, 'timelineMilestones', function (array $cur) use ($id, $in, $cleanTitle, $cleanDate, $cleanColor, $byDate) {
            $found = false;
            foreach ($cur as &$m) {
                if (($m['id'] ?? '') !== $id) continue;
                if (array_key_exists('title', $in)) $m['title'] = $cleanTitle($in['title']);
                if (array_key_exists('date', $in))  $m['date']  = $cleanDate($in['date']);
                if (array_key_exists('color', $in)) $m['color'] = $cleanColor($in['color']);
                $found = true;
            }
            unset($m);
            if (!$found) {
                json_error('Milestone not found', 404);
            }
            return $byDate($cur);
        });
        json_out(['ok' => true, 'milestones' => $list]);

    case 'delete':
        $id = (string) ($in['id'] ?? '');
        $list = store_list_mutate($pid, 'timelineMilestones', function (array $cur) use ($id) {
            return array_filter($cur, fn ($m) => ($m['id'] ?? '') !== $id);
        });
        json_out(['ok' => true, 'milestones' => $list]);

    default:
        json_error("Unknown op '$op' (use create | update | delete)", 400);
}
