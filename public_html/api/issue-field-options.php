<?php
/**
 * Return the single-select Issue fields on an issue, with their options, so the
 * card UI can render dropdowns (e.g. Priority, Effort).
 *
 * GET ?issueId=<node id>  ->  { fields: [ {fieldId, name, currentOptionId, options:[{id,name,color}]} ] }
 *
 * Note: only fields that currently have a value on the issue are returned
 * (they're read from issueFieldValues).
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$issueId = $_GET['issueId'] ?? '';
if (!$issueId) json_error("Missing 'issueId'", 400);

$query = <<<'GQL'
query($id: ID!) {
  node(id: $id) {
    ... on Issue {
      issueFieldValues(first: 30) {
        nodes {
          __typename
          ... on IssueFieldSingleSelectValue {
            optionId
            field { ... on IssueFieldSingleSelect { id name options { id name color } } }
          }
        }
      }
    }
  }
}
GQL;

$data  = gql($query, ['id' => $issueId]);
$nodes = $data['node']['issueFieldValues']['nodes'] ?? [];

$out = [];
foreach ($nodes as $n) {
    if (($n['__typename'] ?? '') !== 'IssueFieldSingleSelectValue') continue;
    $f = $n['field'] ?? null;
    if (!$f) continue;
    $out[] = [
        'fieldId'         => $f['id'],
        'name'            => $f['name'],
        'currentOptionId' => $n['optionId'] ?? null,
        'options'         => $f['options'] ?? [],
    ];
}

json_out(['fields' => $out]);
