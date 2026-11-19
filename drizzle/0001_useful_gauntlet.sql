CREATE TABLE `alert_devices` (
	`deviceId` varchar(80) NOT NULL,
	`role` enum('driver','security') NOT NULL,
	`label` varchar(120) NOT NULL,
	`tokenHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`lastSeenAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alert_devices_deviceId` PRIMARY KEY(`deviceId`)
);
--> statement-breakpoint
CREATE TABLE `alert_fcm_tokens` (
	`id` int AUTO_INCREMENT NOT NULL,
	`deviceId` varchar(80) NOT NULL,
	`token` varchar(512) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `alert_fcm_tokens_id` PRIMARY KEY(`id`),
	CONSTRAINT `alert_fcm_tokens_device_token_uq` UNIQUE(`deviceId`,`token`)
);
--> statement-breakpoint
CREATE TABLE `alert_locations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`alertId` varchar(120) NOT NULL,
	`driverDeviceId` varchar(80) NOT NULL,
	`latitude` double NOT NULL,
	`longitude` double NOT NULL,
	`capturedAt` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alert_locations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alert_pair_codes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`securityDeviceId` varchar(80) NOT NULL,
	`codeHash` varchar(64) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`usedAt` timestamp,
	`attempts` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alert_pair_codes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `alert_pairings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`driverDeviceId` varchar(80) NOT NULL,
	`securityDeviceId` varchar(80) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `alert_pairings_id` PRIMARY KEY(`id`),
	CONSTRAINT `alert_pairings_driver_security_uq` UNIQUE(`driverDeviceId`,`securityDeviceId`)
);
--> statement-breakpoint
CREATE TABLE `alert_records` (
	`alertId` varchar(120) NOT NULL,
	`driverDeviceId` varchar(80) NOT NULL,
	`driverName` varchar(120) NOT NULL,
	`vehicleModel` varchar(100) NOT NULL,
	`vehicleColor` varchar(60) NOT NULL,
	`vehiclePlate` varchar(30) NOT NULL,
	`latitude` double,
	`longitude` double,
	`locationSource` enum('current','last','none') NOT NULL,
	`capturedAt` varchar(64) NOT NULL,
	`status` enum('new','acknowledged','resolved') NOT NULL DEFAULT 'new',
	`trackingActive` boolean NOT NULL DEFAULT true,
	`acknowledgedBy` varchar(80),
	`acknowledgedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `alert_records_alertId` PRIMARY KEY(`alertId`)
);
--> statement-breakpoint
CREATE INDEX `alert_devices_role_idx` ON `alert_devices` (`role`);--> statement-breakpoint
CREATE INDEX `alert_fcm_tokens_device_idx` ON `alert_fcm_tokens` (`deviceId`);--> statement-breakpoint
CREATE INDEX `alert_locations_alert_idx` ON `alert_locations` (`alertId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `alert_locations_driver_idx` ON `alert_locations` (`driverDeviceId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `alert_pair_codes_hash_idx` ON `alert_pair_codes` (`codeHash`);--> statement-breakpoint
CREATE INDEX `alert_pair_codes_security_idx` ON `alert_pair_codes` (`securityDeviceId`);--> statement-breakpoint
CREATE INDEX `alert_pairings_driver_idx` ON `alert_pairings` (`driverDeviceId`);--> statement-breakpoint
CREATE INDEX `alert_pairings_security_idx` ON `alert_pairings` (`securityDeviceId`);--> statement-breakpoint
CREATE INDEX `alert_records_driver_idx` ON `alert_records` (`driverDeviceId`);--> statement-breakpoint
CREATE INDEX `alert_records_created_idx` ON `alert_records` (`createdAt`);--> statement-breakpoint
CREATE INDEX `alert_records_updated_idx` ON `alert_records` (`updatedAt`);