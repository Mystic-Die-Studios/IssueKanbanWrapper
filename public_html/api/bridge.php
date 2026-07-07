<?php
/**
 * Server-to-server integration bridge.
 *
 * Unlike every other endpoint here, this one is NOT authenticated by a user's
 * GitHub OAuth session. It's meant to be called machine-to-machine by a trusted
 * peer app (the Employee Dashboard's Django backend), authorized by a shared
 * secret and reading the board with a configured service token.
 *
 * Auth:   header  X-Bridge-Secret: <BRIDGE_SECRET from config>
 * Params: ?include=summary  -> also return a small live board summary
 *
 * Response (no GitHub call needed — proves the channel is up):
 *   { ok, service, github_configured, project_configured }
 * With ?include=summary and a valid service token + PROJECT_ID:
 *   ...plus  board: { title, itemCount }
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';

// --- Shared-secret auth (constant-time compare) ---------------------------
$provided = $_SERVER['HTTP_X_BRIDGE_SECRET'] ?? '';
$expected = (string) config('BRIDGE_SECRET', '');
if ($expected === '' || !is_string($provided) || !hash_equals($expected, $provided)) {
    json_error('Invalid or missing bridge secret', 401);
}

$serviceToken = (string) config('SERVICE_GITHUB_TOKEN', '');
$projectId    = (string) config('PROJECT_ID', '');
$projectOk    = $projectId !== '' && strpos($projectId, 'PVT_') === 0;

$out = [
    'ok'                 => true,
    'service'            => 'issue-kanban-bridge',
    'github_configured'  => $serviceToken !== '',
    'project_configured' => $projectOk,
];

// Optionally prove the GitHub path end-to-end with the service token.
if (($_GET['include'] ?? '') === 'summary') {
    if ($serviceToken === '' || !$projectOk) {
        $out['board_error'] = 'Service token or PROJECT_ID not configured';
    } else {
        $query = 'query($id:ID!){ node(id:$id){ ... on ProjectV2 { title items { totalCount } } } }';
        [$code, $body] = http_request(
            'POST',
            'https://api.github.com/graphql',
            gh_headers($serviceToken, true),
            json_encode(['query' => $query, 'variables' => ['id' => $projectId]])
        );
        if ($code < 400 && is_array($body) && empty($body['errors']) && !empty($body['data']['node'])) {
            $node = $body['data']['node'];
            $out['board'] = [
                'title'     => $node['title'] ?? null,
                'itemCount' => $node['items']['totalCount'] ?? null,
            ];
        } else {
            $out['board_error'] = 'Could not read board with service token';
        }
    }
}

json_out($out);
