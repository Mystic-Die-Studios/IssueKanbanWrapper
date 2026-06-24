<?php
/**
 * Set a generic Projects v2 field on an item: Story Points (number) or
 * Sprint (iteration), or clear it.
 *
 * POST JSON: { itemId, fieldId, kind, value }
 *   kind  = "number" | "iteration" | "singleSelect" | "text" | "date"
 *   value = the value, or null to clear the field
 */
declare(strict_types=1);
require __DIR__ . '/gh.php';
require_auth();

$in = json_input();
foreach (['itemId', 'fieldId', 'kind'] as $k) {
    if (empty($in[$k])) {
        json_error("Missing '$k'", 400);
    }
}

$value = $in['value'] ?? null;
$kind  = $in['kind'];

if ($value === null || $value === '') {
    $payload = null; // clear
} else {
    switch ($kind) {
        case 'number':
            $payload = ['number' => (float) $value];
            break;
        case 'date':
            $payload = ['date' => (string) $value]; // YYYY-MM-DD
            break;
        case 'iteration':
            $payload = ['iterationId' => (string) $value];
            break;
        case 'singleSelect':
            $payload = ['singleSelectOptionId' => (string) $value];
            break;
        case 'text':
            $payload = ['text' => (string) $value];
            break;
        default:
            json_error("Unknown kind '$kind'", 400);
    }
}

pv2_update_field(config('PROJECT_ID'), $in['itemId'], $in['fieldId'], $payload);

json_out(['ok' => true]);
