<?php
/**
 * List an issue's relationships (native GitHub):
 *   - parent / children  via the sub-issues API   (apiVersion 2022-11-28)
 *   - blockedBy / blocking via issue dependencies  (apiVersion 2026-03-10)
 *
 * GET ?repo=owner/name&number=12
 * ->  { ok, parent, children:[], blockedBy:[], blocking:[], warnings:[] }
 *
 * Each related issue is { repo, number, title, url, state, id }.
 * A section that the repo doesn't support (feature off) degrades to empty with
 * a note in `warnings`, so the modal still renders the rest.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_auth();

const DEPS_API = '2026-03-10';

$repo = $_GET['repo'] ?? '';
$num  = $_GET['number'] ?? null;

if (!preg_match('#^[^/\s]+/[^/\s]+$#', $repo)) {
    json_error("Missing or invalid 'repo'", 400);
}
if (!ctype_digit((string) $num)) {
    json_error("Missing or invalid 'number'", 400);
}
$num = (int) $num;

$warnings = [];

/** Map a REST list to compact briefs; record a warning and return [] on failure. */
function rel_list(string $path, string $label, array &$warnings, string $api = '2022-11-28'): array
{
    [$code, $body] = rest('GET', $path, null, $api);
    if ($code >= 400 || !is_array($body)) {
        $warnings[] = $label;
        return [];
    }
    return array_map('gh_issue_brief', $body);
}

// Parent: 200 with an issue, or 404 when the issue has no parent.
$parent = null;
[$pcode, $pbody] = rest('GET', "/repos/{$repo}/issues/{$num}/parent");
if ($pcode < 300 && is_array($pbody) && !empty($pbody['id'])) {
    $parent = gh_issue_brief($pbody);
} elseif ($pcode >= 400 && $pcode !== 404) {
    // 404 = "no parent"; other 4xx/5xx mean the feature/issue is unavailable.
    $warnings[] = 'parent';
}

$children  = rel_list("/repos/{$repo}/issues/{$num}/sub_issues", 'children', $warnings);
$blockedBy = rel_list("/repos/{$repo}/issues/{$num}/dependencies/blocked_by", 'blockedBy', $warnings, DEPS_API);
$blocking  = rel_list("/repos/{$repo}/issues/{$num}/dependencies/blocking", 'blocking', $warnings, DEPS_API);

json_out([
    'ok'        => true,
    'parent'    => $parent,
    'children'  => $children,
    'blockedBy' => $blockedBy,
    'blocking'  => $blocking,
    'warnings'  => $warnings,
]);
