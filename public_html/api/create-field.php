<?php
/**
 * Create a Projects v2 custom field (safe / non-destructive).
 * Used to add a "Story Points" Number field when the board doesn't have one.
 *
 * POST JSON: { name, dataType?: "NUMBER" | "TEXT" | "DATE" }  (default NUMBER)
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$in   = json_input();
$name = trim((string) ($in['name'] ?? ''));
$type = strtoupper((string) ($in['dataType'] ?? 'NUMBER'));

if ($name === '') {
    json_error('Field name is required', 400);
}
if (!in_array($type, ['NUMBER', 'TEXT', 'DATE'], true)) {
    json_error('Unsupported dataType (NUMBER, TEXT or DATE)', 400);
}

$mutation = <<<'GQL'
mutation($p: ID!, $t: ProjectV2CustomFieldType!, $n: String!) {
  createProjectV2Field(input: { projectId: $p, dataType: $t, name: $n }) {
    projectV2Field { ... on ProjectV2FieldCommon { id name dataType } }
  }
}
GQL;

$data = gql($mutation, ['p' => config('PROJECT_ID'), 't' => $type, 'n' => $name]);

json_out(['ok' => true, 'field' => $data['createProjectV2Field']['projectV2Field'] ?? null]);
