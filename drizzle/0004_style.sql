ALTER TABLE `brief_templates` ADD `style` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `style` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` DROP COLUMN `num_predict`;