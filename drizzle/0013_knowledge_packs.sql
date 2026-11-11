ALTER TABLE `knowledge_bases` ADD `embedding_model` text;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `package_id` text;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `meta` text;--> statement-breakpoint
ALTER TABLE `knowledge_bases` ADD `auto_link` integer DEFAULT false NOT NULL;