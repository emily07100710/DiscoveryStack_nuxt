ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `cycleId` varchar(160);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `candidateArtifactId` varchar(160);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `datasetFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `splitFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `metricsFingerprint` varchar(128);--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `reasonCodes` json;--> statement-breakpoint
ALTER TABLE `geoOutcomeModelopsAdvisoryAssignments` ADD `productionActivation` boolean DEFAULT false NOT NULL;