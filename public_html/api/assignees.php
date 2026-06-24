<?php
/**
 * Replace the full set of assignees on an issue.
 * POST JSON: { repo: "owner/name", number: 12, assignees: ["octocat"] }
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$in = json_input();
$repo      = $in['repo']      ?? '';
$number    = $in['number']    ?? null;
$assignees = $in['assignees'] ?? null;

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!is_int($number) && !ctype_digit((string) $number)) {
    json_error("Missing or invalid 'number'", 400);
}
if (!is_array($assignees)) {
    json_error("'assignees' must be an array", 400);
}

// PATCH replaces the assignee set wholesale.
[$code, $body] = rest('PATCH', "/repos/{$repo}/issues/{$number}", ['assignees' => array_values($assignees)]);
if ($code >= 400) {
    json_error('Failed to set assignees', 502, $body);
}

json_out(['ok' => true]);
