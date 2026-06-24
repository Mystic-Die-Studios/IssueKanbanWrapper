<?php
/**
 * Helper: list the Projects v2 boards the logged-in user can see, with their
 * node ids (PVT_...). Use this once to find the PROJECT_ID for your config.
 *
 * Visit /api/auth/login.php first, then open /api/projects.php.
 * Output is an HTML page (easy to copy from); add ?format=json for raw JSON.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';

if (!current_token()) {
    header('Location: /api/auth/login.php');
    exit;
}

$query = <<<'GQL'
query {
  viewer {
    login
    projectsV2(first: 50) {
      nodes { id number title url closed }
    }
    organizations(first: 20) {
      nodes {
        login
        projectsV2(first: 50) {
          nodes { id number title url closed }
        }
      }
    }
  }
}
GQL;

$data = gql($query);
$viewer = $data['viewer'] ?? [];

// Flatten into [ owner => [ {id, number, title, url, closed} ] ]
$groups = [];
$me = $viewer['login'] ?? 'me';
$groups[$me] = $viewer['projectsV2']['nodes'] ?? [];
foreach (($viewer['organizations']['nodes'] ?? []) as $org) {
    $groups[$org['login']] = $org['projectsV2']['nodes'] ?? [];
}

// JSON mode
if (($_GET['format'] ?? '') === 'json') {
    json_out($groups);
}

// HTML mode
header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Your Projects v2 boards</title>
  <style>
    body { font: 14px/1.5 -apple-system, Segoe UI, Roboto, sans-serif; background:#0d1117; color:#e6edf3; padding:24px; }
    h1 { font-size:18px; } h2 { font-size:15px; color:#8b949e; margin-top:24px; }
    table { border-collapse:collapse; width:100%; max-width:900px; }
    th, td { text-align:left; padding:6px 10px; border-bottom:1px solid #30363d; }
    th { color:#8b949e; font-size:12px; }
    code { background:#161b22; border:1px solid #30363d; border-radius:4px; padding:2px 6px; }
    a { color:#2f81f7; }
    .hint { color:#8b949e; margin-bottom:16px; }
    button { background:#21262d; color:#e6edf3; border:1px solid #30363d; border-radius:5px; padding:3px 8px; cursor:pointer; }
  </style>
</head>
<body>
  <h1>Your Projects v2 boards</h1>
  <p class="hint">Copy the <code>id</code> (starts with <code>PVT_</code>) of the board you want into
     <code>PROJECT_ID</code> in your config, then reload the app.</p>

<?php foreach ($groups as $owner => $nodes): ?>
  <h2><?= htmlspecialchars($owner) ?></h2>
  <?php if (!$nodes): ?>
    <p class="hint">No boards found for this owner.</p>
  <?php else: ?>
    <table>
      <tr><th>#</th><th>Title</th><th>PROJECT_ID</th><th></th></tr>
      <?php foreach ($nodes as $n): ?>
        <tr>
          <td><a href="<?= htmlspecialchars($n['url']) ?>" target="_blank">#<?= (int)$n['number'] ?></a></td>
          <td><?= htmlspecialchars($n['title']) ?><?= !empty($n['closed']) ? ' (closed)' : '' ?></td>
          <td><code id="id-<?= htmlspecialchars($n['id']) ?>"><?= htmlspecialchars($n['id']) ?></code></td>
          <td><button onclick="navigator.clipboard.writeText('<?= htmlspecialchars($n['id']) ?>')">Copy</button></td>
        </tr>
      <?php endforeach; ?>
    </table>
  <?php endif; ?>
<?php endforeach; ?>

</body>
</html>
