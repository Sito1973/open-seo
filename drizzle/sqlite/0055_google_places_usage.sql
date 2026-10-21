CREATE TABLE `google_places_usage` (
	`month` text NOT NULL,
	`sku` text NOT NULL,
	`calls` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`month`, `sku`)
);
