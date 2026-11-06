CREATE TABLE `message_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text NOT NULL,
	`role` text NOT NULL,
	`part` integer DEFAULT 0 NOT NULL,
	`text` text NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_chunks_conversation_idx` ON `message_chunks` (`conversation_id`,`model`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `long_memory` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `memory_refs` text;