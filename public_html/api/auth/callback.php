<?php
/**
 * OAuth callback: validate state, exchange the code for an access token,
 * store it in the session, then redirect back to the app.
 */
declare(strict_types=1);
require __DIR__ . '/../gh.php';

/** Friendly "sign in again" page (instead of a raw JSON error on a redirect). */
function relogin_page(string $msg = 'Your sign-in session expired or could not be verified.'): void
{
    http_response_code(401);
    header('Content-Type: text/html; charset=utf-8');
    $m = htmlspecialchars($msg, ENT_QUOTES);
    echo <<<HTML
    <!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in again</title><link rel="stylesheet" href="/assets/app.css"></head>
    <body><div class="login-screen"><div class="login-card">
      <h1>Sign in again</h1>
      <p>$m</p>
      <a class="btn btn-primary" href="/api/auth/login.php">Sign in with GitHub</a>
    </div></div></body></html>
    HTML;
    exit;
}

$code  = $_GET['code']  ?? null;
$state = $_GET['state'] ?? null;

$stateOk = $state && isset($_SESSION['oauth_state']) && hash_equals($_SESSION['oauth_state'], $state);

if (!$code || !$stateOk) {
    // Usually a transient session/cache blip. Silently retry the OAuth flow once;
    // if it fails again, show a friendly "sign in again" page (never raw JSON).
    if (empty($_COOKIE['oauth_retry'])) {
        setcookie('oauth_retry', '1', time() + 120, '/');
        header('Location: /api/auth/login.php');
        exit;
    }
    relogin_page();
}
unset($_SESSION['oauth_state']);
setcookie('oauth_retry', '', time() - 3600, '/'); // clear the retry guard on success path

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
    relogin_page('GitHub did not return an access token. Please try signing in again.');
}

// Regenerate the id first (prevents session fixation), then store the token.
// session_regenerate_id keeps existing $_SESSION data across the new id.
session_regenerate_id(true);
$_SESSION['gh_token'] = $body['access_token'];

// Back to the app root.
header('Location: /');
exit;
