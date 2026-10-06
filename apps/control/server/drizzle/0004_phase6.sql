CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`gate_id` integer,
	`run_id` integer,
	`round` integer NOT NULL,
	`idx` integer NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`recommended` text,
	`answer` text,
	`answered_via` text,
	`delegated` integer DEFAULT false NOT NULL,
	`answered_at` integer,
	`slack_ts` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`gate_id`) REFERENCES `gates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `skill_picks` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `grill_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `grill` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `grill_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `attachments` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `links` text DEFAULT '[]' NOT NULL;