<?php
/**
 * Issue comments.
 *
 * GET  ?repo=owner/name&number=12  -> { comments: [ {id, author, avatarUrl, body, createdAt, url} ] }
 * POST { repo, number, body }       -> { comment: {…} }
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

/** Normalize a GitHub comment object to the compact shape the modal uses. */
function comment_brief(array $c): array
{
    return [
        'id'        => $c['id'] ?? null,
        'author'    => $c['user']['login']      ?? null,
        'avatarUrl' => $c['user']['avatar_url'] ?? null,
        'body'      => $c['body']       ?? '',
        'createdAt' => $c['created_at'] ?? null,
        'url'       => $c['html_url']   ?? null,
    ];
}

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    $repo = $_GET['repo'] ?? '';
    $num  = $_GET['number'] ?? null;
    if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
        json_error("Missing or invalid 'repo'", 400);
    }
    if (!ctype_digit((string) $num)) {
        json_error("Missing or invalid 'number'", 400);
    }

    [$code, $body] = rest('GET', "/repos/{$repo}/issues/{$num}/comments?per_page=100");
    if ($code >= 400 || !is_array($body)) {
        json_error('Failed to load comments', 502, $body);
    }
    json_out(['comments' => array_map('comment_brief', $body)]);
}

// POST -> add a comment
$in   = json_input();
$repo = $in['repo'] ?? '';
$num  = $in['number'] ?? null;
$text = trim((string) ($in['body'] ?? ''));

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!ctype_digit((string) $num)) {
    json_error("Missing or invalid 'number'", 400);
}
if ($text === '') {
    json_error('Comment body is required', 400);
}

[$code, $c] = rest('POST', "/repos/{$repo}/issues/{$num}/comments", ['body' => $text]);
if ($code >= 400 || !is_array($c) || empty($c['id'])) {
    json_error('Failed to post comment', 502, $c);
}
json_out(['comment' => comment_brief($c)]);
