CREATE TABLE `knowledge_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`part` integer DEFAULT 0 NOT NULL,
	`locator` text,
	`text` text NOT NULL,
	`model` text NOT NULL,
	`embedding` blob NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `knowledge_documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_chunks_document_idx` ON `knowledge_chunks` (`document_id`,`model`);--> statement-breakpoint
CREATE TABLE `knowledge_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`source` text NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`error` text,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`connection_id` text,
	`source` text NOT NULL,
	`title` text NOT NULL,
	`ref` text NOT NULL,
	`version` text,
	`hash` text,
	`bytes` integer,
	`chars` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`chunk_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`indexed_at` integer,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `knowledge_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `knowledge_documents_conversation_idx` ON `knowledge_documents` (`conversation_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `knowledge` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `knowledge` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `knowledge_refs` text;