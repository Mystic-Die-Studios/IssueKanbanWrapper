<?php
/**
 * Set or clear an issue's milestone.
 * POST JSON: { repo: "owner/name", number: 12, milestone: 3 | null }
 *   milestone = the milestone NUMBER, or null to clear.
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$in = json_input();
$repo   = $in['repo']   ?? '';
$number = $in['number'] ?? null;
$ms     = array_key_exists('milestone', $in) ? $in['milestone'] : false;

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!is_int($number) && !ctype_digit((string) $number)) {
    json_error("Missing or invalid 'number'", 400);
}
if ($ms === false) {
    json_error("Missing 'milestone' (use null to clear)", 400);
}

// GitHub: set milestone to the number, or null to remove.
$payload = ['milestone' => $ms === null ? null : (int) $ms];

[$code, $body] = rest('PATCH', "/repos/{$repo}/issues/{$number}", $payload);
if ($code >= 400) {
    json_error('Failed to set milestone', 502, $body);
}

json_out(['ok' => true]);
