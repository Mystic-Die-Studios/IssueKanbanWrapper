<?php
/**
 * Replace the full set of labels on an issue.
 * POST JSON: { repo: "owner/name", number: 12, labels: ["bug","team:frontend"] }
 *
 * We use PUT (replace) so the UI sends the desired final state — simplest to
 * keep client and GitHub in sync.
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$in = json_input();
$repo   = $in['repo']   ?? '';
$number = $in['number'] ?? null;
$labels = $in['labels'] ?? null;

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!is_int($number) && !ctype_digit((string) $number)) {
    json_error("Missing or invalid 'number'", 400);
}
if (!is_array($labels)) {
    json_error("'labels' must be an array", 400);
}

[$code, $body] = rest('PUT', "/repos/{$repo}/issues/{$number}/labels", ['labels' => array_values($labels)]);
if ($code >= 400) {
    json_error('Failed to set labels', 502, $body);
}

json_out(['ok' => true]);
