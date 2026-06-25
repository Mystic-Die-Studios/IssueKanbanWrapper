<?php
/**
 * Permanently delete a GitHub issue.
 * POST JSON: { issueId }   (the Issue node id)
 *
 * This is irreversible and requires the user to have delete permission on the
 * repository; GitHub returns an error otherwise, which is surfaced to the client.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in      = json_input();
$issueId = $in['issueId'] ?? '';
if (!$issueId) {
    json_error("Missing 'issueId'", 400);
}

$mutation = <<<'GQL'
mutation($id: ID!) {
  deleteIssue(input: { issueId: $id }) { repository { id } }
}
GQL;

gql($mutation, ['id' => $issueId]);

json_out(['ok' => true]);
