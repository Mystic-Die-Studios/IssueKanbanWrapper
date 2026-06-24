<?php
/**
 * Edit an issue's title and/or body, or change its open/closed state.
 * POST JSON: { repo: "owner/name", number: 12, title?, body?, state? }
 *   state = "open" | "closed" (optional)
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$in = json_input();
$repo   = $in['repo']   ?? '';
$number = $in['number'] ?? null;

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!is_int($number) && !ctype_digit((string) $number)) {
    json_error("Missing or invalid 'number'", 400);
}

$payload = [];
if (array_key_exists('title', $in)) {
    $title = trim((string) $in['title']);
    if ($title === '') {
        json_error('Title cannot be empty', 400);
    }
    $payload['title'] = $title;
}
if (array_key_exists('body', $in)) {
    $payload['body'] = (string) $in['body'];
}
if (array_key_exists('state', $in)) {
    if (!in_array($in['state'], ['open', 'closed'], true)) {
        json_error("'state' must be 'open' or 'closed'", 400);
    }
    $payload['state'] = $in['state'];
}
if (!$payload) {
    json_error('Nothing to update', 400);
}

[$code, $body] = rest('PATCH', "/repos/{$repo}/issues/{$number}", $payload);
if ($code >= 400) {
    json_error('Failed to update issue', 502, $body);
}

json_out(['ok' => true]);
