ALTER TABLE `conversations` ADD `auto_summary` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary_up_to` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `summary_updated_at` integer;