<?php
/**
 * Begin the GitHub OAuth flow: generate a CSRF state token and redirect the
 * browser to GitHub's authorize endpoint.
 */
declare(strict_types=1);
require __DIR__ . '/../gh.php';

$state = bin2hex(random_bytes(16));
$_SESSION['oauth_state'] = $state;

$params = http_build_query([
    'client_id'    => config('OAUTH_CLIENT_ID'),
    'redirect_uri' => config('OAUTH_REDIRECT'),
    'scope'        => config('OAUTH_SCOPES', 'project repo'),
    'state'        => $state,
    'allow_signup' => 'false',
]);

header('Location: https://github.com/login/oauth/authorize?' . $params);
exit;
