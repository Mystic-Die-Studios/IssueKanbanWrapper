<?php
/**
 * Move a card to a new Status (single-select) option.
 * POST JSON: { itemId, fieldId, optionId }
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$in = json_input();
foreach (['itemId', 'fieldId', 'optionId'] as $k) {
    if (empty($in[$k])) {
        json_error("Missing '$k'", 400);
    }
}

pv2_update_field(
    config('PROJECT_ID'),
    $in['itemId'],
    $in['fieldId'],
    ['singleSelectOptionId' => $in['optionId']]
);

json_out(['ok' => true]);
