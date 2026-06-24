<?php
/** Return the logged-in GitHub user (or 401 if not authenticated). */
declare(strict_types=1);
require __DIR__ . '/gh.php';

if (!current_token()) {
    json_out(['authenticated' => false]);
}

$data = gql('query { viewer { login name avatarUrl } }');
$v = $data['viewer'] ?? null;

json_out([
    'authenticated' => true,
    'login'         => $v['login']     ?? null,
    'name'          => $v['name']      ?? null,
    'avatarUrl'     => $v['avatarUrl'] ?? null,
]);
