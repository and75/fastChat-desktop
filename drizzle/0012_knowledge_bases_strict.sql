PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_knowledge_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`base_id` text NOT NULL,
	`source` text NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`error` text,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_connections`("id", "base_id", "source", "config", "status", "error", "last_sync_at", "created_at") SELECT "id", "base_id", "source", "config", "status", "error", "last_sync_at", "created_at" FROM `knowledge_connections`;--> statement-breakpoint
DROP TABLE `knowledge_connections`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_connections` RENAME TO `knowledge_connections`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`base_id` text NOT NULL,
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
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`indexed_at` integer,
	FOREIGN KEY (`base_id`) REFERENCES `knowledge_bases`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `knowledge_connections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_knowledge_documents`("id", "base_id", "connection_id", "source", "title", "ref", "version", "hash", "bytes", "chars", "status", "error", "chunk_count", "pinned", "created_at", "indexed_at") SELECT "id", "base_id", "connection_id", "source", "title", "ref", "version", "hash", "bytes", "chars", "status", "error", "chunk_count", "pinned", "created_at", "indexed_at" FROM `knowledge_documents`;--> statement-breakpoint
DROP TABLE `knowledge_documents`;--> statement-breakpoint
ALTER TABLE `__new_knowledge_documents` RENAME TO `knowledge_documents`;--> statement-breakpoint
CREATE INDEX `knowledge_documents_base_idx` ON `knowledge_documents` (`base_id`,`created_at`);