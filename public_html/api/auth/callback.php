<?php
/**
 * OAuth callback: validate state, exchange the code for an access token,
 * store it in the session, then redirect back to the app.
 */
declare(strict_types=1);
require __DIR__ . '/../gh.php';

$code  = $_GET['code']  ?? null;
$state = $_GET['state'] ?? null;

if (!$code) {
    json_error('Missing authorization code', 400);
}
if (!$state || !isset($_SESSION['oauth_state']) || !hash_equals($_SESSION['oauth_state'], $state)) {
    json_error('Invalid OAuth state (possible CSRF). Try logging in again.', 400);
}
unset($_SESSION['oauth_state']);

// Exchange the code for a token.
$payload = json_encode([
    'client_id'     => config('OAUTH_CLIENT_ID'),
    'client_secret' => config('OAUTH_CLIENT_SECRET'),
    'code'          => $code,
    'redirect_uri'  => config('OAUTH_REDIRECT'),
]);

[$status, $body] = http_request(
    'POST',
    'https://github.com/login/oauth/access_token',
    [
        'Accept: application/json',
        'Content-Type: application/json',
        'User-Agent: IssueKanbanWrapper',
    ],
    $payload
);

if ($status >= 400 || !is_array($body) || empty($body['access_token'])) {
    json_error('Failed to obtain access token from GitHub', 502, $body);
}

// Regenerate the id first (prevents session fixation), then store the token.
// session_regenerate_id keeps existing $_SESSION data across the new id.
session_regenerate_id(true);
$_SESSION['gh_token'] = $body['access_token'];

// Back to the app root.
header('Location: /');
exit;
