<?php
/**
 * Set (or clear) a GitHub Issue field value via setIssueFieldValue.
 *
 * POST JSON: { issueId, fieldId, kind, value }
 *   kind  = "date" | "number" | "text" | "select"
 *   value = the value, or null/"" to clear (delete) the field value
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in      = json_input();
$issueId = $in['issueId'] ?? '';
$fieldId = $in['fieldId'] ?? '';
$kind    = $in['kind'] ?? '';
$value   = array_key_exists('value', $in) ? $in['value'] : null;

if (!$issueId) json_error("Missing 'issueId'", 400);
if (!$fieldId) json_error("Missing 'fieldId'", 400);

$field = ['fieldId' => $fieldId];
if ($value === null || $value === '') {
    $field['delete'] = true;
} else {
    switch ($kind) {
        case 'date':   $field['dateValue']            = (string) $value; break;
        case 'number': $field['numberValue']          = (float) $value;  break;
        case 'text':   $field['textValue']            = (string) $value; break;
        case 'select': $field['singleSelectOptionId'] = (string) $value; break;
        default: json_error("Unknown kind '$kind'", 400);
    }
}

$mutation = <<<'GQL'
mutation($issueId: ID!, $fields: [IssueFieldCreateOrUpdateInput!]!) {
  setIssueFieldValue(input: { issueId: $issueId, issueFields: $fields }) {
    clientMutationId
  }
}
GQL;

gql($mutation, ['issueId' => $issueId, 'fields' => [$field]]);

json_out(['ok' => true]);
