CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer,
	`run_id` integer,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `gates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`subject` text,
	`decision` text,
	`comment` text,
	`auto` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`protected_branches` text DEFAULT '[]' NOT NULL,
	`build_cmd` text,
	`test_cmd` text,
	`lint_cmd` text,
	`test_globs` text DEFAULT '[]' NOT NULL,
	`gh_account` text,
	`git_author` text,
	`allowlist` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_name_unique` ON `repos` (`name`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`role` text NOT NULL,
	`step` text NOT NULL,
	`model` text NOT NULL,
	`effort` text,
	`session_id` text,
	`status` text NOT NULL,
	`error` text,
	`doc` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`thinking_tokens` integer DEFAULT 0 NOT NULL,
	`duration_ms` integer,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`title` text NOT NULL,
	`input` text NOT NULL,
	`kind` text DEFAULT 'feature' NOT NULL,
	`size` text,
	`needs_debugger` integer DEFAULT false NOT NULL,
	`needs_researcher` integer DEFAULT false NOT NULL,
	`design_flag` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`resume_status` text,
	`status_note` text,
	`feedback` text,
	`loop_count` integer DEFAULT 0 NOT NULL,
	`replan_count` integer DEFAULT 0 NOT NULL,
	`test_failures` integer DEFAULT 0 NOT NULL,
	`token_estimate` integer,
	`files_in_scope` text DEFAULT '[]' NOT NULL,
	`branch` text,
	`base_sha` text,
	`worktree_path` text,
	`pr_url` text,
	`resume_at` integer,
	`done_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE no action
);
