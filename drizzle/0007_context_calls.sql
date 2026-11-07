CREATE TABLE `context_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`model` text NOT NULL,
	`num_ctx` integer,
	`parts` text NOT NULL,
	`dropped_messages` integer DEFAULT 0 NOT NULL,
	`prompt_eval_count` integer,
	`eval_count` integer,
	`load_ms` integer,
	`prompt_eval_ms` integer,
	`eval_ms` integer,
	`duration_ms` integer,
	`done_reason` text,
	`aborted` integer DEFAULT false NOT NULL,
	`error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_calls_conversation_idx` ON `context_calls` (`conversation_id`,`created_at`);