<?php
/**
 * Shared helpers: config loading, session, and authenticated GitHub calls
 * (GraphQL + REST). Every API endpoint includes this file.
 */

declare(strict_types=1);

// ---------------------------------------------------------------------------
// Never cache dynamic / authenticated responses. On LiteSpeed (Namecheap) the
// server may otherwise cache the OAuth login redirect, replaying a stale `state`
// and breaking sign-in. These headers + the public_html/.htaccess rule disable it.
// ---------------------------------------------------------------------------
if (!headers_sent()) {
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('X-LiteSpeed-Cache-Control: no-cache');
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
if (session_status() !== PHP_SESSION_ACTIVE) {
    // httpOnly so client JS can never read the cookie; lax is fine for the
    // OAuth redirect-back flow. Secure only when actually on HTTPS.
    $https = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https')
        || (($_SERVER['SERVER_PORT'] ?? '') == 443);
    session_set_cookie_params([
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $https,
    ]);
    session_start();
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Load config.local.php on localhost, config.php otherwise.
 * Cached so repeated calls are cheap.
 */
function config_load(): array
{
    static $cfg = null;
    if ($cfg !== null) {
        return $cfg;
    }

    $dir  = dirname(__DIR__); // public_html/
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $isLocal = (strpos($host, 'localhost') === 0) || (strpos($host, '127.0.0.1') === 0);

    $local = $dir . '/config.local.php';
    $prod  = $dir . '/config.php';

    if ($isLocal && is_file($local)) {
        $cfg = require $local;
    } elseif (is_file($prod)) {
        $cfg = require $prod;
    } elseif (is_file($local)) {
        $cfg = require $local;
    } else {
        json_error('No config file found. Copy config.example.php to config.php (or config.local.php).', 500);
    }

    return $cfg;
}

function config(string $key, $default = null)
{
    $cfg = config_load();
    return $cfg[$key] ?? $default;
}

// ---------------------------------------------------------------------------
// Auth state
// ---------------------------------------------------------------------------

function current_token(): ?string
{
    return $_SESSION['gh_token'] ?? null;
}

/** Send 401 JSON and exit if the user is not logged in. */
function require_auth(): string
{
    $token = current_token();
    if (!$token) {
        json_error('Not authenticated', 401);
    }
    return $token;
}

// ---------------------------------------------------------------------------
// JSON response helpers
// ---------------------------------------------------------------------------

function json_out($data, int $code = 200): void
{
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data);
    exit;
}

function json_error(string $message, int $code = 400, $extra = null): void
{
    $payload = ['error' => $message];
    if ($extra !== null) {
        $payload['detail'] = $extra;
    }
    json_out($payload, $code);
}

/** Read and decode a JSON request body. Returns [] on empty/invalid. */
function json_input(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// ---------------------------------------------------------------------------
// HTTP / GitHub transports
// ---------------------------------------------------------------------------

/**
 * Low-level curl wrapper. Returns [status_code, decoded_body, raw_body].
 */
function http_request(string $method, string $url, array $headers = [], ?string $body = null): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $headers,
        CURLOPT_TIMEOUT        => 30,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }

    $raw  = curl_exec($ch);
    if ($raw === false) {
        $err = curl_error($ch);
        curl_close($ch);
        json_error('Network error contacting GitHub: ' . $err, 502);
    }
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $decoded = json_decode((string) $raw, true);
    return [$code, $decoded, (string) $raw];
}

function gh_headers(string $token, bool $json = true): array
{
    $h = [
        'Authorization: Bearer ' . $token,
        'User-Agent: IssueKanbanWrapper',
        'Accept: application/vnd.github+json',
        'X-GitHub-Api-Version: 2022-11-28',
    ];
    if ($json) {
        $h[] = 'Content-Type: application/json';
    }
    return $h;
}

/**
 * Run a GraphQL query/mutation. Returns the `data` payload.
 * Exits with JSON error on transport or GraphQL errors.
 */
function gql(string $query, array $variables = [])
{
    $token = require_auth();
    $payload = json_encode(['query' => $query, 'variables' => (object) $variables]);

    [$code, $body] = http_request(
        'POST',
        'https://api.github.com/graphql',
        gh_headers($token),
        $payload
    );

    if ($code === 401) {
        // token expired/revoked
        unset($_SESSION['gh_token']);
        json_error('GitHub authentication expired. Please log in again.', 401);
    }
    if ($code >= 400 || !is_array($body)) {
        json_error('GitHub GraphQL error', 502, $body);
    }
    if (!empty($body['errors'])) {
        json_error('GitHub GraphQL error', 502, $body['errors']);
    }

    return $body['data'] ?? null;
}

/**
 * Set a Projects v2 item field value.
 * $value is a ProjectV2FieldValue object, e.g.
 *   ['singleSelectOptionId' => '...']  |  ['number' => 5]  |  ['iterationId' => '...']  |  ['text' => '...']
 * Pass $value = null to clear the field.
 */
function pv2_update_field(string $projectId, string $itemId, string $fieldId, ?array $value)
{
    if ($value === null) {
        $mutation = <<<'GQL'
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
          clearProjectV2ItemFieldValue(input: {
            projectId: $projectId, itemId: $itemId, fieldId: $fieldId
          }) { projectV2Item { id } }
        }
        GQL;
        return gql($mutation, compact('projectId', 'itemId', 'fieldId'));
    }

    $mutation = <<<'GQL'
    mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value
      }) { projectV2Item { id } }
    }
    GQL;
    return gql($mutation, [
        'projectId' => $projectId,
        'itemId'    => $itemId,
        'fieldId'   => $fieldId,
        'value'     => $value,
    ]);
}

/**
 * Run a REST call against api.github.com.
 * $path is the path after the host, e.g. "/repos/owner/repo/issues/12".
 * Returns [status_code, decoded_body].
 */
function rest(string $method, string $path, ?array $body = null): array
{
    $token = require_auth();
    $url = 'https://api.github.com' . $path;
    $json = $body !== null ? json_encode($body) : null;

    [$code, $decoded] = http_request($method, $url, gh_headers($token), $json);

    if ($code === 401) {
        unset($_SESSION['gh_token']);
        json_error('GitHub authentication expired. Please log in again.', 401);
    }

    return [$code, $decoded];
}
