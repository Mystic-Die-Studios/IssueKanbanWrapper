<?php
/**
 * Attach a pull request to an issue by adding a reference to the PR body.
 * GitHub has no direct "link PR" mutation; a closing keyword in the PR body is
 * what creates the linked-PR relationship (and auto-closes on merge).
 *
 * POST JSON: { repo, issueNumber, prNumber, keyword?: "Closes" | "Refs" }
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in          = json_input();
$repo        = $in['repo']        ?? '';
$issueNumber = $in['issueNumber'] ?? null;
$prNumber    = $in['prNumber']    ?? null;
$keyword     = $in['keyword']     ?? 'Closes';

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!ctype_digit((string) $issueNumber)) {
    json_error("Missing or invalid 'issueNumber'", 400);
}
if (!ctype_digit((string) $prNumber)) {
    json_error("Missing or invalid 'prNumber'", 400);
}
if (!in_array($keyword, ['Closes', 'Refs'], true)) {
    $keyword = 'Closes';
}

[$c, $pr] = rest('GET', "/repos/{$repo}/pulls/{$prNumber}");
if ($c >= 400 || !is_array($pr) || empty($pr['html_url'])) {
    json_error('Pull request not found', 404, $pr);
}

$body = (string) ($pr['body'] ?? '');

// Skip if the issue is already referenced with a linking keyword.
$already = (bool) preg_match(
    '/\b(close[sd]?|fix(e[sd])?|resolve[sd]?|refs?)\b\s*#' . preg_quote((string) $issueNumber, '/') . '\b/i',
    $body
);

if (!$already) {
    $ref = $keyword . ' #' . $issueNumber;
    $newBody = $ref . "\n\n" . $body;
    [$c2, $res] = rest('PATCH', "/repos/{$repo}/pulls/{$prNumber}", ['body' => $newBody]);
    if ($c2 >= 400) {
        json_error('Failed to update the pull request body', 502, $res);
    }
}

json_out([
    'ok'      => true,
    'already' => $already,
    'pr'      => [
        'number' => (int) $prNumber,
        'url'    => $pr['html_url'],
        'title'  => $pr['title'] ?? null,
        'state'  => $pr['state'] ?? null,
        'draft'  => $pr['draft'] ?? false,
    ],
]);
