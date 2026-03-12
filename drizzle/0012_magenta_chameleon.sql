PRAGMA foreign_keys=OFF;--> statement-breakpoint
DROP TABLE IF EXISTS `__new_agent_sdks`;--> statement-breakpoint
CREATE TABLE `__new_agent_sdks` (
	`name` text PRIMARY KEY NOT NULL,
	`authentication` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_agent_sdks`("name", "authentication", "status") SELECT
	"name",
	"authentication",
	CASE
		WHEN "authentication" = 'unauthenticated' THEN 'unconfigured'
		ELSE 'configured'
	END AS "status"
FROM `agent_sdks`;--> statement-breakpoint
DROP TABLE `agent_sdks`;--> statement-breakpoint
ALTER TABLE `__new_agent_sdks` RENAME TO `agent_sdks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
