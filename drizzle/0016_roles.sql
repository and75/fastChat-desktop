CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`package_id` text,
	`role_group` text,
	`language` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`version` text,
	`definition` text NOT NULL,
	`origin` text DEFAULT 'package' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `brief_templates` ADD `role_id` text;--> statement-breakpoint
ALTER TABLE `brief_templates` ADD `role_params` text;--> statement-breakpoint
ALTER TABLE `brief_templates` ADD `mind_overrides` text;--> statement-breakpoint
ALTER TABLE `brief_templates` ADD `situation` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `role_id` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `role_params` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `mind_overrides` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `situation` text;