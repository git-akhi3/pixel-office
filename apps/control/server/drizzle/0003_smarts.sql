CREATE TABLE `knowledge_proposals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`task_id` integer,
	`text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `repos` ADD `skills` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `graphify` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `graphify` integer DEFAULT false NOT NULL;