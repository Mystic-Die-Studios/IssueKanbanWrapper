<?php
/**
 * Fetch the full Projects v2 board and return normalized JSON:
 *   - fields:    discovered field metadata (Status options, Sprint iterations,
 *                field ids needed for mutations)
 *   - items:     every board item with status / sprint / points / issue content
 *
 * Shared by stats.php (which re-uses fetch_board()).
 */
declare(strict_types=1);
require_once __DIR__ . '/gh.php';
require_once __DIR__ . '/store.php';

/**
 * Query the board's field definitions once. Returns a map keyed by field name:
 *   name => ['id'=>..., 'dataType'=>..., 'options'=>[{id,name}], 'iterations'=>[{id,title,startDate,duration}]]
 */
function fetch_fields(string $projectId): array
{
    $query = <<<'GQL'
    query($id: ID!) {
      node(id: $id) {
        ... on ProjectV2 {
          fields(first: 50) {
            nodes {
              ... on ProjectV2FieldCommon { id name dataType }
              ... on ProjectV2SingleSelectField {
                id name dataType
                options { id name }
              }
              ... on ProjectV2IterationField {
                id name dataType
                configuration {
                  iterations { id title startDate duration }
                  completedIterations { id title startDate duration }
                }
              }
            }
          }
        }
      }
    }
    GQL;

    $data = gql($query, ['id' => $projectId]);
    $nodes = $data['node']['fields']['nodes'] ?? [];

    $byName = [];
    foreach ($nodes as $f) {
        if (empty($f['name'])) {
            continue;
        }
        $entry = [
            'id'       => $f['id']       ?? null,
            'dataType' => $f['dataType'] ?? null,
        ];
        if (isset($f['options'])) {
            $entry['options'] = $f['options'];
        }
        if (isset($f['configuration'])) {
            $active    = $f['configuration']['iterations'] ?? [];
            $completed = $f['configuration']['completedIterations'] ?? [];
            // Mark completed ones so the UI can group them.
            foreach ($completed as &$c) { $c['completed'] = true; }
            unset($c);
            foreach ($active as &$a) { $a['completed'] = false; }
            unset($a);
            $entry['iterations'] = array_merge($active, $completed);
        }
        $byName[$f['name']] = $entry;
    }
    return $byName;
}

/**
 * Fetch all board items (paginated). Returns a normalized array of items.
 *
 * Sub-issue (parent) and dependency (blocked-by / blocking) fields are newer
 * GraphQL schema additions that may require preview feature headers and could be
 * unavailable. To avoid ever breaking the board, we try progressively richer
 * queries and fall back: parent+dependencies -> parent only -> base.
 */
function fetch_items(string $projectId): array
{
    $levels = [
        ['feat' => 'sub_issues,issue_dependencies',
         'rel'  => 'parent { number repository { nameWithOwner } } blockedBy(first: 1) { totalCount } blocking(first: 1) { totalCount }'],
        ['feat' => 'sub_issues',
         'rel'  => 'parent { number repository { nameWithOwner } }'],
        ['feat' => null, 'rel' => ''],
    ];
    foreach ($levels as $lvl) {
        $items = fetch_items_try($projectId, $lvl['rel'], $lvl['feat']);
        if ($items !== null) {
            return $items;
        }
    }
    return [];
}

/**
 * Run the paginated items query at one enrichment level. Returns the normalized
 * items, or null if any page errors (so the caller can fall back).
 */
function fetch_items_try(string $projectId, string $rel, ?string $features): ?array
{
    $query = <<<GQL
    query(\$id: ID!, \$after: String) {
      node(id: \$id) {
        ... on ProjectV2 {
          items(first: 50, after: \$after) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              type
              content {
                __typename
                ... on Issue {
                  id number title url state body
                  repository { nameWithOwner }
                  milestone { title number }
                  assignees(first: 10) { nodes { login name avatarUrl } }
                  labels(first: 20) { nodes { name color } }
                  {$rel}
                  issueFieldValues(first: 30) {
                    nodes {
                      __typename
                      ... on IssueFieldDateValue { dateValue: value field { ... on IssueFieldDate { id name } } }
                      ... on IssueFieldNumberValue { numberValue: value field { ... on IssueFieldNumber { id name } } }
                      ... on IssueFieldSingleSelectValue { selectValue: name color optionId field { ... on IssueFieldSingleSelect { id name options { id name color } } } }
                      ... on IssueFieldTextValue { textValue: value field { ... on IssueFieldText { id name } } }
                    }
                  }
                }
                ... on DraftIssue { id title body }
              }
              fieldValues(first: 20) {
                nodes {
                  __typename
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name optionId field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldNumberValue {
                    number field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldDateValue {
                    date field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldIterationValue {
                    title iterationId startDate field { ... on ProjectV2FieldCommon { name } }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text field { ... on ProjectV2FieldCommon { name } }
                  }
                }
              }
            }
          }
        }
      }
    }
    GQL;

    $items = [];
    $after = null;
    do {
        $res = gql($query, ['id' => $projectId, 'after' => $after], true, $features);
        if (!empty($res['errors']) || empty($res['data'])) {
            return null;
        }
        $conn = $res['data']['node']['items'] ?? null;
        if (!$conn) {
            return null;
        }
        foreach ($conn['nodes'] as $node) {
            $items[] = normalize_item($node);
        }
        $after = $conn['pageInfo']['hasNextPage'] ? $conn['pageInfo']['endCursor'] : null;
    } while ($after !== null);

    return $items;
}

/** Flatten one raw item node into a UI-friendly shape. */
function normalize_item(array $node): array
{
    $content = $node['content'] ?? [];
    $type    = $content['__typename'] ?? 'Unknown';

    $fields = [];
    foreach (($node['fieldValues']['nodes'] ?? []) as $fv) {
        $fname = $fv['field']['name'] ?? null;
        if (!$fname) {
            continue;
        }
        switch ($fv['__typename']) {
            case 'ProjectV2ItemFieldSingleSelectValue':
                $fields[$fname] = ['type' => 'single_select', 'name' => $fv['name'] ?? null, 'optionId' => $fv['optionId'] ?? null];
                break;
            case 'ProjectV2ItemFieldNumberValue':
                $fields[$fname] = ['type' => 'number', 'number' => $fv['number'] ?? null];
                break;
            case 'ProjectV2ItemFieldDateValue':
                $fields[$fname] = ['type' => 'date', 'date' => $fv['date'] ?? null];
                break;
            case 'ProjectV2ItemFieldIterationValue':
                $fields[$fname] = ['type' => 'iteration', 'title' => $fv['title'] ?? null, 'iterationId' => $fv['iterationId'] ?? null, 'startDate' => $fv['startDate'] ?? null];
                break;
            case 'ProjectV2ItemFieldTextValue':
                $fields[$fname] = ['type' => 'text', 'text' => $fv['text'] ?? null];
                break;
        }
    }

    // New GitHub "Issue fields" (Priority, Effort, Start date, Target date, …)
    $issueFields = [];
    foreach (($content['issueFieldValues']['nodes'] ?? []) as $fv) {
        $type = $fv['__typename'] ?? '';
        $name = $fv['field']['name'] ?? null;
        $fid  = $fv['field']['id'] ?? null;
        if (!$name) continue;
        switch ($type) {
            case 'IssueFieldDateValue':
                $d = $fv['dateValue'] ?? null;
                if ($d && strpos($d, 'T') !== false) $d = substr($d, 0, 10);
                $issueFields[$name] = ['type' => 'date', 'value' => $d, 'fieldId' => $fid];
                break;
            case 'IssueFieldNumberValue':
                $issueFields[$name] = ['type' => 'number', 'value' => $fv['numberValue'] ?? null, 'fieldId' => $fid];
                break;
            case 'IssueFieldSingleSelectValue':
                $issueFields[$name] = ['type' => 'select', 'value' => $fv['selectValue'] ?? null, 'optionId' => $fv['optionId'] ?? null, 'color' => $fv['color'] ?? null, 'fieldId' => $fid, 'options' => $fv['field']['options'] ?? []];
                break;
            case 'IssueFieldTextValue':
                $issueFields[$name] = ['type' => 'text', 'value' => $fv['textValue'] ?? null, 'fieldId' => $fid];
                break;
        }
    }

    $assignees = [];
    foreach (($content['assignees']['nodes'] ?? []) as $a) {
        $assignees[] = ['login' => $a['login'], 'name' => $a['name'] ?? null, 'avatarUrl' => $a['avatarUrl'] ?? null];
    }
    $labels = [];
    foreach (($content['labels']['nodes'] ?? []) as $l) {
        $labels[] = ['name' => $l['name'], 'color' => $l['color'] ?? '888888'];
    }

    return [
        'itemId'    => $node['id'],          // ProjectV2Item id (for field mutations)
        'type'      => $type,                // Issue | DraftIssue | Unknown
        'issueId'   => $content['id']     ?? null,  // Issue node id
        'number'    => $content['number'] ?? null,
        'title'     => $content['title']  ?? '(untitled)',
        'url'       => $content['url']    ?? null,
        'state'     => $content['state']  ?? null,
        'body'      => $content['body']   ?? '',
        'repo'      => $content['repository']['nameWithOwner'] ?? null,
        'milestone' => isset($content['milestone']) && $content['milestone']
                        ? ['title' => $content['milestone']['title'], 'number' => $content['milestone']['number']]
                        : null,
        'assignees'   => $assignees,
        'labels'      => $labels,
        'fields'      => $fields,           // Projects v2 field values, keyed by field name
        'issueFields' => $issueFields,      // GitHub Issue fields, keyed by field name
        'parent'      => isset($content['parent']) && $content['parent']
                        ? ['number' => $content['parent']['number'] ?? null,
                           'repo'   => $content['parent']['repository']['nameWithOwner'] ?? null]
                        : null,
        'blockedBy'   => (int) ($content['blockedBy']['totalCount'] ?? 0),  // issues blocking this one
        'blocking'    => (int) ($content['blocking']['totalCount'] ?? 0),   // issues this one blocks
    ];
}

/** Fetch the board's title/url/number (for headers and deep-links). */
function fetch_project_info(string $projectId): array
{
    $query = 'query($id: ID!) { node(id: $id) { ... on ProjectV2 { title url number } } }';
    $data = gql($query, ['id' => $projectId]);
    $n = $data['node'] ?? [];
    return [
        'title'  => $n['title']  ?? 'Project',
        'url'    => $n['url']    ?? null,
        'number' => $n['number'] ?? null,
    ];
}

/** Fetch fields + items together. Reused by stats.php. */
function fetch_board(): array
{
    $projectId = config('PROJECT_ID');
    if (!$projectId || strpos($projectId, 'PVT_') !== 0) {
        json_error('PROJECT_ID is not configured (must start with "PVT_"). See config.example.php.', 500);
    }
    $info   = fetch_project_info($projectId);
    $prefix = config('SPRINT_PREFIX', 'sprint:');
    $fields = fetch_fields($projectId);
    $items  = fetch_items($projectId);

    // Resolve configured field names to the board's ACTUAL field names so a
    // case/spacing mismatch doesn't break writes. Returns the real name or null.
    $statusName = resolve_field_name($fields, config('FIELD_STATUS'), ['status'], 'SINGLE_SELECT');
    $pointsName = resolve_field_name($fields, config('FIELD_POINTS'), ['point', 'estimate'], 'NUMBER');
    // Be explicit for dates: with both "Start date" and "End date" present, match
    // by name/hint only (no single-type fallback, which would be ambiguous).
    $startName  = resolve_field_name($fields, config('FIELD_START'), ['start']);
    $dueName    = resolve_field_name($fields, config('FIELD_DUE'), ['due', 'end', 'deadline', 'target']);
    if ($dueName === null) {
        // Only one date field on the board? then use it as the due date.
        $dueName = resolve_field_name($fields, config('FIELD_DUE'), [], 'DATE');
    }

    // Aggregate the GitHub *Issue* field definitions (id + type) seen across all
    // items, keyed by name. The issue-field id is stable per repo, so this gives
    // us the id even for issues where the field is currently empty — which is
    // what lets the client write issue-backed date fields (Start/Target date)
    // via setIssueFieldValue instead of the project mutation, which GitHub
    // rejects for issue fields.
    $issueFieldDefs = [];

    // Derive sprint (from label) and start/due dates (from issue fields or
    // project date fields) for each item.
    foreach ($items as &$it) {
        foreach (($it['issueFields'] ?? []) as $n => $f) {
            if (!empty($f['fieldId']) && (!isset($issueFieldDefs[$n]) || (($f['type'] ?? '') === 'select' && empty($issueFieldDefs[$n]['options']) && !empty($f['options'])))) {
                $def = ['id' => $f['fieldId'], 'type' => $f['type'] ?? null];
                if (($f['type'] ?? '') === 'select') $def['options'] = $f['options'] ?? [];
                $issueFieldDefs[$n] = $def;
            }
        }

        $it['sprint'] = null;
        foreach ($it['labels'] as $l) {
            if (strpos($l['name'], $prefix) === 0) {
                $it['sprint'] = substr($l['name'], strlen($prefix));
                break;
            }
        }

        // collect all date values from both sources, keyed by field name
        $dates = [];
        foreach (($it['issueFields'] ?? []) as $n => $f) {
            if (($f['type'] ?? '') === 'date' && !empty($f['value'])) $dates[$n] = $f['value'];
        }
        foreach (($it['fields'] ?? []) as $n => $f) {
            if (($f['type'] ?? '') === 'date' && !empty($f['date'])) $dates[$n] = $f['date'];
        }
        $it['start'] = pick_date($dates, config('FIELD_START'), ['start']);
        $it['due']   = pick_date($dates, config('FIELD_DUE'), ['due', 'target', 'end', 'deadline']);
    }
    unset($it);

    return [
        'config' => [
            'statusField'   => $statusName,
            'pointsField'   => $pointsName,             // null if the board has no points field
            'pointsName'    => config('FIELD_POINTS'),  // desired name (used by the "create field" button)
            'startField'    => $startName,              // null if the board has no start-date field
            'startName'     => config('FIELD_START'),
            'dueField'      => $dueName,                // null if the board has no due-date field
            'dueName'       => config('FIELD_DUE'),
            'statusDone'    => config('STATUS_DONE'),
            'teamPrefix'    => config('TEAM_PREFIX', 'team:'),
            'sprintPrefix'  => $prefix,
            'defaultMilestone' => config('DEFAULT_MILESTONE', ''),
            'helpWantedLabel'  => config('HELP_WANTED_LABEL', 'help wanted'),
            'projectTitle'  => $info['title'],
            'projectUrl'    => $info['url'],
        ],
        'fields'      => $fields,
        'issueFields' => $issueFieldDefs,   // name => {id, type} for GitHub Issue fields
        'items'       => $items,
        'sprints'     => sprints_get($projectId),
        'snapshots'   => snapshots_get($projectId),
    ];
}

/** Pick a date value from a name=>date map by exact name, then hint substring. */
function pick_date(array $map, ?string $wanted, array $hints = []): ?string
{
    if ($wanted) {
        foreach ($map as $n => $v) {
            if (strcasecmp($n, $wanted) === 0) return $v;
        }
    }
    foreach ($map as $n => $v) {
        $low = strtolower($n);
        foreach ($hints as $h) {
            if (strpos($low, strtolower($h)) !== false) return $v;
        }
    }
    return null;
}

/**
 * Find the real field name on the board for a configured name.
 *   1) exact (case-insensitive) match of $wanted
 *   2) fuzzy: field name contains any hint substring
 *   3) type fallback: if exactly one field has the given $dataType, use it
 * Returns the actual field name, or null if nothing matches / it's ambiguous.
 */
function resolve_field_name(array $fields, ?string $wanted, array $hints = [], ?string $dataType = null): ?string
{
    $names = array_keys($fields);
    if ($wanted) {
        foreach ($names as $n) {
            if (strcasecmp($n, $wanted) === 0) {
                return $n;
            }
        }
    }
    foreach ($names as $n) {
        $low = strtolower($n);
        foreach ($hints as $h) {
            if (strpos($low, strtolower($h)) !== false) {
                return $n;
            }
        }
    }
    if ($dataType) {
        $matches = [];
        foreach ($fields as $n => $meta) {
            if (strcasecmp((string) ($meta['dataType'] ?? ''), $dataType) === 0) {
                $matches[] = $n;
            }
        }
        if (count($matches) === 1) {
            return $matches[0];
        }
    }
    return null;
}

// --- main (only when board.php is the requested endpoint, not when included) ---
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === realpath(__FILE__)) {
    require_auth();
    json_out(fetch_board());
}
