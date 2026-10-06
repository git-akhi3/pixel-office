ALTER TABLE `tasks` ADD `lane` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_id` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `depends_on` integer;