<?php
/**
 * Delete a board card.
 * POST JSON: { issueId?, itemId?, type? }
 *
 * Real issues (issueId starts "I_") are permanently deleted via deleteIssue
 * (requires repo delete permission). Draft issues (issueId starts "DI_", or
 * type === "DraftIssue") only live inside the project, so they're removed with
 * deleteProjectV2Item instead — deleteIssue can't resolve a draft node id.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in      = json_input();
$issueId = (string) ($in['issueId'] ?? '');
$itemId  = (string) ($in['itemId'] ?? '');
$type    = (string) ($in['type'] ?? '');

$isDraft = ($type === 'DraftIssue')
        || (strncmp($issueId, 'DI_', 3) === 0)
        || ($issueId === '' && $itemId !== '');

if ($isDraft) {
    if (!$itemId) {
        json_error("Missing 'itemId' for draft deletion", 400);
    }
    $mutation = <<<'GQL'
    mutation($p: ID!, $i: ID!) {
      deleteProjectV2Item(input: { projectId: $p, itemId: $i }) { deletedItemId }
    }
    GQL;
    gql($mutation, ['p' => config('PROJECT_ID'), 'i' => $itemId]);
} else {
    if (!$issueId) {
        json_error("Missing 'issueId'", 400);
    }
    $mutation = <<<'GQL'
    mutation($id: ID!) {
      deleteIssue(input: { issueId: $id }) { repository { id } }
    }
    GQL;
    gql($mutation, ['id' => $issueId]);
}

json_out(['ok' => true]);
