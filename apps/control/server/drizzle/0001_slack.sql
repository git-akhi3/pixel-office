ALTER TABLE `gates` ADD `slack_ts` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `slack_channel` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `slack_thread_ts` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `slack_status_ts` text;