<?php
/**
 * Assign (or clear) an issue's sprint by managing its sprint label.
 *
 * POST JSON: { repo, number, labels: [current label names], sprint: "Sprint 3" | null }
 *
 * Behavior: remove any existing "<SPRINT_PREFIX>*" labels, then (if a sprint is
 * given) ensure the "<SPRINT_PREFIX><name>" label exists in the repo and add it.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in = json_input();
$repo   = $in['repo']   ?? '';
$number = $in['number'] ?? null;
$labels = $in['labels'] ?? null;
$sprint = array_key_exists('sprint', $in) ? $in['sprint'] : false;

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!is_int($number) && !ctype_digit((string) $number)) {
    json_error("Missing or invalid 'number'", 400);
}
if (!is_array($labels)) {
    json_error("'labels' must be an array of current label names", 400);
}
if ($sprint === false) {
    json_error("Missing 'sprint' (use null to clear)", 400);
}

$prefix = config('SPRINT_PREFIX', 'sprint:');

// Drop any existing sprint labels.
$next = array_values(array_filter($labels, fn($l) => strpos((string) $l, $prefix) !== 0));

if ($sprint !== null && trim((string) $sprint) !== '') {
    $label = $prefix . trim((string) $sprint);

    // Ensure the label exists (201 created or 422 already-exists are both fine).
    rest('POST', "/repos/{$repo}/labels", [
        'name'        => $label,
        'color'       => '5319e7',
        'description' => 'Sprint (managed by Issue Kanban)',
    ]);

    $next[] = $label;
}

[$code, $body] = rest('PUT', "/repos/{$repo}/issues/{$number}/labels", ['labels' => $next]);
if ($code >= 400) {
    json_error('Failed to set sprint label', 502, $body);
}

json_out(['ok' => true, 'labels' => $next]);
