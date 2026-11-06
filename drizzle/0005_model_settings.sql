CREATE TABLE `model_settings` (
	`model` text PRIMARY KEY NOT NULL,
	`digest` text,
	`num_gpu` integer,
	`benchmark` text,
	`benchmarked_at` integer,
	`gpu_available` integer,
	`dismissed` integer DEFAULT false NOT NULL
);
