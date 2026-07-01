<?php
/**
 * Fetch repo-level metadata for the card edit dropdowns:
 * labels, open milestones, and assignable users.
 *
 * GET ?repo=owner/name
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$repo = $_GET['repo'] ?? '';
if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo' (expected owner/name)", 400);
}

/** GET all pages of a REST list endpoint (caps at 5 pages to stay snappy). */
function rest_all(string $path): array
{
    $out = [];
    for ($page = 1; $page <= 5; $page++) {
        $sep = strpos($path, '?') === false ? '?' : '&';
        [$code, $body] = rest('GET', "{$path}{$sep}per_page=100&page={$page}");
        if ($code >= 400 || !is_array($body) || count($body) === 0) {
            break;
        }
        $out = array_merge($out, $body);
        if (count($body) < 100) {
            break;
        }
    }
    return $out;
}

$labels = array_map(
    fn($l) => ['name' => $l['name'], 'color' => $l['color'] ?? '888888'],
    rest_all("/repos/{$repo}/labels")
);

$milestones = array_map(
    fn($m) => ['number' => $m['number'], 'title' => $m['title']],
    rest_all("/repos/{$repo}/milestones?state=open")
);

// Assignable users via GraphQL so we get each user's profile display name
// (the REST /assignees endpoint only returns login + avatar).
[$owner, $name] = explode('/', $repo, 2);
$assignees = [];
$after = null;
for ($page = 1; $page <= 5; $page++) {
    $data = gql(
        'query($owner:String!, $name:String!, $after:String) {
          repository(owner:$owner, name:$name) {
            assignableUsers(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { login name avatarUrl }
            }
          }
        }',
        ['owner' => $owner, 'name' => $name, 'after' => $after]
    );
    $conn = $data['repository']['assignableUsers'] ?? null;
    if (!$conn) {
        break;
    }
    foreach ($conn['nodes'] as $u) {
        $assignees[] = ['login' => $u['login'], 'name' => $u['name'] ?? null, 'avatarUrl' => $u['avatarUrl'] ?? null];
    }
    if (empty($conn['pageInfo']['hasNextPage'])) {
        break;
    }
    $after = $conn['pageInfo']['endCursor'];
}

json_out([
    'labels'     => $labels,
    'milestones' => $milestones,
    'assignees'  => $assignees,
]);
