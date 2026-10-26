-- POD photos live under proof-of-delivery/ in the uploads bucket.
-- Keep rider-pod/ accepted so any earlier keys still pass the check.
ALTER TABLE "rider_pod_images" DROP CONSTRAINT IF EXISTS "rider_pod_images_key_ck";
--> statement-breakpoint
ALTER TABLE "rider_pod_images" ADD CONSTRAINT "rider_pod_images_key_ck" CHECK (
  ("storage_key" LIKE 'proof-of-delivery/%' OR "storage_key" LIKE 'rider-pod/%')
);
