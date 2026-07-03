<?php
/**
 * App shell. Shows a login screen when there's no session, otherwise the
 * Kanban board UI (driven by assets/app.js).
 */
declare(strict_types=1);
require __DIR__ . '/api/gh.php';

$loggedIn = (bool) current_token();

// Cache-bust static assets by their mtime so browsers pick up new builds
// immediately instead of serving a stale app.js/app.css.
$asset = function (string $path): string {
    $full = __DIR__ . $path;
    $v = is_file($full) ? filemtime($full) : null;
    return $path . ($v ? '?v=' . $v : '');
};
?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Issue Kanban</title>
  <link rel="stylesheet" href="<?= htmlspecialchars($asset('/assets/app.css'), ENT_QUOTES) ?>">
</head>
<body>
<?php if (!$loggedIn): ?>
  <div class="login-screen">
    <div class="login-card">
      <h1>Issue Kanban</h1>
      <p>A better view and control surface for your GitHub Projects board.</p>
      <a class="btn btn-primary" href="/api/auth/login.php">Sign in with GitHub</a>
    </div>
  </div>
<?php else: ?>
  <header class="topbar">
    <div class="topbar-left">
      <strong id="project-title">Issue Kanban</strong>
      <nav class="tabs">
        <button class="tab active" data-view="board">Board</button>
        <button class="tab" data-view="timeline">Timeline</button>
        <button class="tab" data-view="stats">Stats</button>
      </nav>
      <button id="new-issue-btn" class="btn btn-primary">+ New issue</button>
      <button id="help-wanted-btn" class="btn btn-help" aria-pressed="false" title="Show only issues labelled help wanted">🆘 Help wanted</button>
    </div>
    <div class="topbar-right">
      <button id="backfill-btn" class="btn btn-ghost hidden" title="Assign the default milestone to issues that have none"></button>
      <button id="warn-btn" class="btn btn-warn hidden" title="Issues missing a sprint or points"></button>
      <label class="toggle">
        <input type="checkbox" id="filter-mine"> My issues
      </label>
      <button id="refresh-btn" class="btn btn-ghost" title="Reload board data from GitHub">↻ Refresh</button>
      <span id="user-chip" class="user-chip"></span>
      <a class="btn btn-ghost" href="/api/auth/logout.php">Sign out</a>
    </div>
  </header>

  <div id="sprint-bar" class="sprint-bar"></div>
  <div id="filter-bar" class="filter-bar"></div>

  <main id="app">
    <div id="board-view" class="board"></div>
    <div id="timeline-view" class="timeline hidden"></div>
    <div id="stats-view" class="stats hidden"></div>
    <div id="loading" class="loading">Loading board…</div>
    <div id="error" class="error hidden"></div>
  </main>

  <!-- Card detail / edit modal -->
  <div id="modal" class="modal hidden">
    <div class="modal-backdrop"></div>
    <div class="modal-body" id="modal-body"></div>
  </div>

  <script src="<?= htmlspecialchars($asset('/assets/app.js'), ENT_QUOTES) ?>"></script>
<?php endif; ?>
</body>
</html>
