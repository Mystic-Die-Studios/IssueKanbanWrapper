<?php
/**
 * Add or remove a native GitHub relationship between two issues.
 *
 * POST JSON: {
 *   repo, number,                 // the issue being edited (the "source")
 *   targetRepo, targetNumber,     // the other issue
 *   type: 'child'|'parent'|'blockedBy'|'blocking',
 *   op:   'add'|'remove'
 * }
 *
 * Relationship semantics (from the source issue's point of view):
 *   child     -> target is a sub-issue of source
 *   parent    -> target is the parent of source (source is a sub-issue of target)
 *   blockedBy -> source is blocked by target
 *   blocking  -> source blocks target
 *
 * Sub-issues use the 2022-11-28 API; dependencies use 2026-03-10. Both key on
 * the numeric issue id, which we resolve from the issue number.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

const DEPS_API = '2026-03-10';

$in    = json_input();
$repo  = $in['repo'] ?? '';
$num   = $in['number'] ?? null;
$tRepo = $in['targetRepo'] ?? '';
$tNum  = $in['targetNumber'] ?? null;
$type  = $in['type'] ?? '';
$op    = $in['op'] ?? '';

foreach (['repo' => $repo, 'targetRepo' => $tRepo] as $k => $v) {
    if (!preg_match('#^[^/\s]+/[^/\s]+$#', (string) $v)) {
        json_error("Missing or invalid '$k'", 400);
    }
}
foreach (['number' => $num, 'targetNumber' => $tNum] as $k => $v) {
    if (!ctype_digit((string) $v)) {
        json_error("Missing or invalid '$k'", 400);
    }
}
if (!in_array($type, ['child', 'parent', 'blockedBy', 'blocking'], true)) {
    json_error("Invalid 'type'", 400);
}
if (!in_array($op, ['add', 'remove'], true)) {
    json_error("Invalid 'op'", 400);
}

$num  = (int) $num;
$tNum = (int) $tNum;
if ($repo === $tRepo && $num === $tNum) {
    json_error('An issue cannot be related to itself', 400);
}

/** Run a relationship REST call; abort with detail on failure. */
function rel_call(string $method, string $path, ?array $body, string $api, string $what): void
{
    [$code, $resp] = rest($method, $path, $body, $api);
    if ($code >= 400) {
        json_error("Could not $what", 502, $resp);
    }
}

// Resolve numeric ids only where the API needs them.
$targetId = gh_issue_brief(gh_issue($tRepo, $tNum))['id'];

switch ($type) {
    case 'child':
        if ($op === 'add') {
            rel_call('POST', "/repos/{$repo}/issues/{$num}/sub_issues", ['sub_issue_id' => $targetId], '2022-11-28', 'add sub-issue');
        } else {
            rel_call('DELETE', "/repos/{$repo}/issues/{$num}/sub_issue", ['sub_issue_id' => $targetId], '2022-11-28', 'remove sub-issue');
        }
        break;

    case 'parent':
        // source becomes (or stops being) a sub-issue of target.
        $sourceId = gh_issue_brief(gh_issue($repo, $num))['id'];
        if ($op === 'add') {
            rel_call('POST', "/repos/{$tRepo}/issues/{$tNum}/sub_issues", ['sub_issue_id' => $sourceId, 'replace_parent' => true], '2022-11-28', 'set parent');
        } else {
            rel_call('DELETE', "/repos/{$tRepo}/issues/{$tNum}/sub_issue", ['sub_issue_id' => $sourceId], '2022-11-28', 'remove parent');
        }
        break;

    case 'blockedBy':
        if ($op === 'add') {
            rel_call('POST', "/repos/{$repo}/issues/{$num}/dependencies/blocked_by", ['issue_id' => $targetId], DEPS_API, 'add blocked-by dependency');
        } else {
            rel_call('DELETE', "/repos/{$repo}/issues/{$num}/dependencies/blocked_by/{$targetId}", null, DEPS_API, 'remove blocked-by dependency');
        }
        break;

    case 'blocking':
        // source blocks target == target is blocked by source.
        $sourceId = gh_issue_brief(gh_issue($repo, $num))['id'];
        if ($op === 'add') {
            rel_call('POST', "/repos/{$tRepo}/issues/{$tNum}/dependencies/blocked_by", ['issue_id' => $sourceId], DEPS_API, 'add blocking dependency');
        } else {
            rel_call('DELETE', "/repos/{$tRepo}/issues/{$tNum}/dependencies/blocked_by/{$sourceId}", null, DEPS_API, 'remove blocking dependency');
        }
        break;
}

json_out(['ok' => true]);
