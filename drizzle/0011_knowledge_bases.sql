CREATE TABLE `conversation_bases` (
	`conversation_id` text NOT NULL,
	`base_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`conversation_id`, `base_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `knowledge_bases` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT 'local' NOT NULL,
	`conversation_id` text,
	`version` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_bases_conversation_idx` ON `knowledge_bases` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `knowledge_connections` ADD `base_id` text REFERENCES knowledge_bases(id);--> statement-breakpoint
ALTER TABLE `knowledge_documents` ADD `base_id` text REFERENCES knowledge_bases(id);--> statement-breakpoint
INSERT INTO `knowledge_bases` (`id`, `name`, `origin`, `conversation_id`)
  SELECT 'kb-' || `id`, '', 'conversation', `id` FROM `conversations`
  WHERE `id` IN (SELECT `conversation_id` FROM `knowledge_documents` UNION SELECT `conversation_id` FROM `knowledge_connections`);--> statement-breakpoint
UPDATE `knowledge_documents` SET `base_id` = 'kb-' || `conversation_id`;--> statement-breakpoint
UPDATE `knowledge_connections` SET `base_id` = 'kb-' || `conversation_id`;
