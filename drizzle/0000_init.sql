CREATE TABLE `brief_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`goals` text DEFAULT '' NOT NULL,
	`constraints` text DEFAULT '' NOT NULL,
	`model` text,
	`temperature` real DEFAULT 0.7 NOT NULL,
	`think` integer DEFAULT false NOT NULL,
	`plan_mode` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT 'Nuova conversazione' NOT NULL,
	`model` text DEFAULT '' NOT NULL,
	`role` text DEFAULT '' NOT NULL,
	`context` text DEFAULT '' NOT NULL,
	`goals` text DEFAULT '' NOT NULL,
	`constraints` text DEFAULT '' NOT NULL,
	`temperature` real DEFAULT 0.7 NOT NULL,
	`think` integer DEFAULT false NOT NULL,
	`plan_mode` integer DEFAULT false NOT NULL,
	`top_p` real,
	`num_ctx` integer,
	`seed` integer,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `conversations_updated_idx` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`thinking` text,
	`model` text,
	`eval_count` integer,
	`duration_ms` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_idx` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_message_id` text NOT NULL,
	`steps` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
