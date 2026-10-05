CREATE TABLE `review_comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`path` text NOT NULL,
	`line` integer NOT NULL,
	`severity` text NOT NULL,
	`body` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `base_branch` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_number` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_repo` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_author` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_head_sha` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_head_ref` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pr_base_ref` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_summary` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_posted_url` text;