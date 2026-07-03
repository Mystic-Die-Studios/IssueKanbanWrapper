<?php
/**
 * Tiny JSON-file storage for sprint definitions, keyed by project id.
 * File lives under public_html/data/ and is blocked from the web by .htaccess.
 *
 * Data shape:
 *   { "<PROJECT_ID>": {
 *       "sprints":   [ {name, startDate, endDate, closed}, ... ],
 *       "snapshots": [ {id, sprint, repo, number, title, points, url,
 *                       assignees:[{login,name,avatarUrl}], pushedTo, createdAt}, ... ]
 *   } }
 *
 * Issue->sprint membership is NOT stored here — it lives as a GitHub label
 * (SPRINT_PREFIX + name). This file holds sprint metadata plus "snapshots":
 * website-only frozen copies of issues that were pushed out of a (now closed)
 * sprint, shown read-only in that sprint's Cancelled/Pushed column.
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';

function sprint_data_dir(): string
{
    $dir = dirname(__DIR__) . '/data'; // public_html/data
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
        // Belt-and-suspenders: drop a deny file even if the repo one is missing.
        @file_put_contents($dir . '/.htaccess', "Require all denied\nDeny from all\n");
    }
    return $dir;
}

function sprint_store_file(): string
{
    return sprint_data_dir() . '/sprints.json';
}

/** Read the sprints array for a project (no lock — read-only callers). */
function sprints_get(string $projectId): array
{
    $f = sprint_store_file();
    if (!is_file($f)) {
        return [];
    }
    $all = json_decode((string) file_get_contents($f), true);
    if (!is_array($all)) {
        return [];
    }
    return $all[$projectId]['sprints'] ?? [];
}

/**
 * Read-modify-write the sprints for a project under an exclusive lock.
 * $fn receives the current sprints array and must return the new one.
 * Returns the new sprints array.
 */
function sprints_mutate(string $projectId, callable $fn): array
{
    $f = sprint_store_file();
    $fp = fopen($f, 'c+');
    if (!$fp) {
        json_error('Unable to open sprint storage for writing', 500);
    }
    flock($fp, LOCK_EX);

    $raw = stream_get_contents($fp);
    $all = json_decode((string) $raw, true);
    if (!is_array($all)) {
        $all = [];
    }
    $current = $all[$projectId]['sprints'] ?? [];

    // NB: $fn may call json_error() (which exits). That happens before we
    // truncate/write below, so the file is left intact and the lock is released
    // on process shutdown.
    $new = array_values($fn($current));

    $all[$projectId]['sprints'] = $new;
    rewind($fp);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    return $new;
}

/** Read the website-only snapshots for a project (read-only, no lock). */
function snapshots_get(string $projectId): array
{
    $f = sprint_store_file();
    if (!is_file($f)) {
        return [];
    }
    $all = json_decode((string) file_get_contents($f), true);
    if (!is_array($all)) {
        return [];
    }
    return $all[$projectId]['snapshots'] ?? [];
}

/**
 * Read-modify-write the snapshots array for a project under an exclusive lock.
 * $fn receives the current snapshots array and must return the new one.
 * Preserves the sibling "sprints" key untouched.
 */
function snapshots_mutate(string $projectId, callable $fn): array
{
    $f = sprint_store_file();
    $fp = fopen($f, 'c+');
    if (!$fp) {
        json_error('Unable to open snapshot storage for writing', 500);
    }
    flock($fp, LOCK_EX);

    $raw = stream_get_contents($fp);
    $all = json_decode((string) $raw, true);
    if (!is_array($all)) {
        $all = [];
    }
    $current = $all[$projectId]['snapshots'] ?? [];
    $new = array_values($fn($current));

    $all[$projectId]['snapshots'] = $new;
    rewind($fp);
    ftruncate($fp, 0);
    fwrite($fp, json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    fflush($fp);
    flock($fp, LOCK_UN);
    fclose($fp);

    return $new;
}
