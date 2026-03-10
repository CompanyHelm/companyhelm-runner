CREATE TABLE `daemon_state` (
	`id` text PRIMARY KEY NOT NULL,
	`pid` integer,
	`log_path` text,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL
);
