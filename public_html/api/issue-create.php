<?php
/**
 * Create a new issue and add it to the project board.
 *
 * POST JSON: { repo, title, body?, assignees?, labels?, milestone? }
 *
 * Labels/assignees must already exist in the repo (GitHub does not auto-create
 * labels). Sprint/points/status are set by the client afterward using the
 * returned itemId/number.
 *
 * Returns: { itemId, number, url, repo, issueId }
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in    = json_input();
$repo  = $in['repo']  ?? '';
$title = trim((string) ($in['title'] ?? ''));

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if ($title === '') {
    json_error('Title is required', 400);
}

$payload = ['title' => $title];
if (array_key_exists('body', $in))                              $payload['body']      = (string) $in['body'];
if (!empty($in['assignees']) && is_array($in['assignees']))    $payload['assignees'] = array_values($in['assignees']);
if (!empty($in['labels']) && is_array($in['labels']))          $payload['labels']    = array_values($in['labels']);
if (isset($in['milestone']) && $in['milestone'] !== '' && $in['milestone'] !== null) {
    $payload['milestone'] = (int) $in['milestone'];
}

[$code, $issue] = rest('POST', "/repos/{$repo}/issues", $payload);
if ($code >= 400 || empty($issue['node_id'])) {
    json_error('Failed to create issue', 502, $issue);
}

// Add the new issue to the project board.
$mutation = <<<'GQL'
mutation($p: ID!, $c: ID!) {
  addProjectV2ItemById(input: { projectId: $p, contentId: $c }) { item { id } }
}
GQL;
$data = gql($mutation, ['p' => config('PROJECT_ID'), 'c' => $issue['node_id']]);
$itemId = $data['addProjectV2ItemById']['item']['id'] ?? null;

json_out([
    'ok'      => true,
    'itemId'  => $itemId,
    'number'  => $issue['number'],
    'url'     => $issue['html_url'] ?? null,
    'repo'    => $repo,
    'issueId' => $issue['node_id'],
]);
