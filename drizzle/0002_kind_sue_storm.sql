PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_threads`;--> statement-breakpoint
CREATE TABLE `__new_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`status` text NOT NULL,
	`workspace` text NOT NULL,
	`runtime_container` text NOT NULL,
	`dind_container` text NOT NULL,
	`home_directory` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_threads`(
	"id",
	"agent_id",
	"model",
	"reasoning_level",
	"status",
	"workspace",
	"runtime_container",
	"dind_container",
	"home_directory",
	"uid",
	"gid"
) SELECT
	"id",
	"agent_id",
	"model",
	"reasoning_level",
	'ready' AS "status",
	"workspace",
	"runtime_container",
	"dind_container",
	"home_directory",
	"uid",
	"gid"
FROM `threads`;--> statement-breakpoint
DROP TABLE `threads`;--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
