<?php
/**
 * List pull requests linked to / referencing an issue.
 * GET ?repo=owner/name&number=12  ->  { prs: [ {number, url, title, state, isDraft} ] }
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

$repo = $_GET['repo'] ?? '';
$num  = $_GET['number'] ?? null;

if (!preg_match('#^([^/\s]+)/([^/\s]+)$#', $repo, $m)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!ctype_digit((string) $num)) {
    json_error("Missing or invalid 'number'", 400);
}

$query = <<<'GQL'
query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) {
    issue(number: $n) {
      timelineItems(first: 100, itemTypes: [CONNECTED_EVENT, CROSS_REFERENCED_EVENT, DISCONNECTED_EVENT]) {
        nodes {
          __typename
          ... on ConnectedEvent     { subject { __typename ... on PullRequest { number url title state isDraft } } }
          ... on DisconnectedEvent  { subject { __typename ... on PullRequest { number } } }
          ... on CrossReferencedEvent { source { __typename ... on PullRequest { number url title state isDraft } } }
        }
      }
    }
  }
}
GQL;

$data  = gql($query, ['o' => $m[1], 'r' => $m[2], 'n' => (int) $num]);
$nodes = $data['repository']['issue']['timelineItems']['nodes'] ?? [];

$prs = [];           // number => pr
$disconnected = [];  // number => true
foreach ($nodes as $nd) {
    $type = $nd['__typename'] ?? '';
    if ($type === 'ConnectedEvent' && ($nd['subject']['__typename'] ?? '') === 'PullRequest') {
        $p = $nd['subject']; $prs[$p['number']] = $p;
    } elseif ($type === 'CrossReferencedEvent' && ($nd['source']['__typename'] ?? '') === 'PullRequest') {
        $p = $nd['source']; $prs[$p['number']] = $p;
    } elseif ($type === 'DisconnectedEvent' && ($nd['subject']['__typename'] ?? '') === 'PullRequest') {
        $disconnected[$nd['subject']['number']] = true;
    }
}
foreach (array_keys($disconnected) as $n) {
    unset($prs[$n]);
}

json_out(['prs' => array_values($prs)]);
