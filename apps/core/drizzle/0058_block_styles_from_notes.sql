-- Daily Notes write like Markdown (#239): existing notes get their line styles. Only styles change:
-- no Block's text, place, Links, Project or Todo does.
-- 1. A top-level Block copied from one of the daily template's sections (its text is a top-level
--    template Block's, or a default section's while the User has no template saved) is a subheading.
UPDATE `block_details` SET `style` = 'heading-2'
WHERE `parent_id` IS NULL AND trim(`text`) <> '' AND trim(`text`) IN (
  SELECT trim(json_extract(`value`, '$.text'))
  FROM `daily_template`, json_each(CASE WHEN json_valid(`template`) THEN `template` END, '$.blocks')
  WHERE `daily_template`.`id` = 1 AND json_type(`value`) = 'object' AND json_extract(`value`, '$.parentId') IS NULL
  UNION ALL
  SELECT `column1` FROM (VALUES ('Morning'), ('Meetings'), ('Todos'), ('Ideas'), ('Evening'))
  WHERE NOT EXISTS (SELECT 1 FROM `daily_template` WHERE `id` = 1 AND json_valid(`template`))
);
--> statement-breakpoint
-- 2. Meeting chips (Blocks Commander made for a meeting, or starting with an event's link) and every
--    line under them are quotes.
WITH RECURSIVE `meeting_lines`(`id`) AS (
  SELECT `item_id` FROM `block_details`
  WHERE `item_id` IN (SELECT `block_id` FROM `meeting_chips`)
    OR substr(ltrim(`text`, ' ' || char(9) || char(10) || char(13)), 1, 8) = '[[event:'
  UNION
  SELECT `block_details`.`item_id` FROM `block_details`
  INNER JOIN `meeting_lines` ON `block_details`.`parent_id` = `meeting_lines`.`id`
)
UPDATE `block_details` SET `style` = 'quote' WHERE `item_id` IN (SELECT `id` FROM `meeting_lines`);
--> statement-breakpoint
-- 3. A Block made into a Todo (a live Todo made from it) is a checkbox Todo, in a meeting or not.
UPDATE `block_details` SET `style` = 'todo'
WHERE `item_id` IN (
  SELECT `links`.`to_item_id` FROM `links`
  INNER JOIN `items` ON `items`.`id` = `links`.`from_item_id`
  WHERE `links`.`type` = 'made-from' AND `items`.`kind` = 'todo' AND `items`.`deleted_at` IS NULL
);
--> statement-breakpoint
-- 4. The daily template's own Blocks: its top-level sections are subheadings, the rest plain lines.
UPDATE `daily_template` SET `template` = json_set(`template`, '$.blocks', json((
  SELECT json_group_array(json(json_set(`value`, '$.style',
    CASE WHEN json_extract(`value`, '$.parentId') IS NULL AND trim(coalesce(json_extract(`value`, '$.text'), '')) <> ''
      THEN 'heading-2' ELSE 'plain' END)) ORDER BY `key`)
  FROM json_each(`template`, '$.blocks')
  WHERE json_type(`value`) = 'object'
)))
WHERE json_valid(`template`) AND json_type(`template`, '$.blocks') = 'array';
