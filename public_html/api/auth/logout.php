<?php
/** Clear the session and return to the app. */
declare(strict_types=1);
require __DIR__ . '/../gh.php';

$_SESSION = [];
if (ini_get('session.use_cookies')) {
    $p = session_get_cookie_params();
    setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'], $p['secure'], $p['httponly']);
}
session_destroy();

header('Location: /');
exit;
