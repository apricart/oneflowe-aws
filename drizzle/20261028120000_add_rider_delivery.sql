-- Rider Delivery Management: additive tables + RIDER role.
-- See plans/OF-RIDER-DELIVERY-backend.md.
--
-- No ALTER of existing tables. Rollback (after deactivating rider accounts):
--   DROP TABLE IF EXISTS "rider_location_events";
--   DROP TABLE IF EXISTS "rider_pod_images";
--   DROP TABLE IF EXISTS "rider_order_assignments";
--   DROP TABLE IF EXISTS "rider_depots";
--   DROP TABLE IF EXISTS "rider_profiles";
--   DELETE FROM "roles" WHERE "name" = 'RIDER' AND NOT EXISTS (
--     SELECT 1 FROM "users" WHERE "users"."role_id" = "roles"."id");

INSERT INTO "roles" ("name", "description")
SELECT 'RIDER', 'Apricart rider: delivers assigned orders for the warehouse'
WHERE NOT EXISTS (SELECT 1 FROM "roles" WHERE "name" = 'RIDER');--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rider_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" varchar(32) NOT NULL,
	"phone" varchar(32),
	"vehicle_number" varchar(64),
	"is_on_duty" boolean DEFAULT false NOT NULL,
	"avatar_url" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rider_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "rider_profiles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_profiles_code_uq" ON "rider_profiles" USING btree ("code");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rider_depots" (
	"id" serial PRIMARY KEY NOT NULL,
	"warehouse_user_id" uuid NOT NULL,
	"name" varchar(255) DEFAULT 'Warehouse' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rider_depots_warehouse_user_id_users_id_fk" FOREIGN KEY ("warehouse_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "rider_depots_lat_ck" CHECK ("latitude" >= -90 AND "latitude" <= 90),
	CONSTRAINT "rider_depots_lng_ck" CHECK ("longitude" >= -180 AND "longitude" <= 180)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_depots_warehouse_user_uq" ON "rider_depots" USING btree ("warehouse_user_id");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rider_order_assignments" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"rider_user_id" uuid NOT NULL,
	"assigned_by_user_id" uuid,
	"delivery_sequence" integer NOT NULL,
	"delivery_lat" double precision NOT NULL,
	"delivery_lng" double precision NOT NULL,
	"delivery_address_text" text,
	"status" varchar(32) DEFAULT 'ASSIGNED' NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"out_for_delivery_at" timestamp with time zone,
	"pod_submitted_at" timestamp with time zone,
	"pod_approved_at" timestamp with time zone,
	"pod_rejected_at" timestamp with time zone,
	"pod_reject_reason" text,
	"arrived_at" timestamp with time zone,
	"arrival_lat" double precision,
	"arrival_lng" double precision,
	"fulfilled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "rider_order_assignments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "rider_order_assignments_rider_user_id_users_id_fk" FOREIGN KEY ("rider_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "rider_order_assignments_assigned_by_user_id_users_id_fk" FOREIGN KEY ("assigned_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "rider_order_assignments_status_ck" CHECK ("status" IN (
		'ASSIGNED', 'OUT_FOR_DELIVERY', 'POD_SUBMITTED', 'POD_REJECTED',
		'POD_APPROVED', 'FULFILLMENT_PENDING', 'FULFILLMENT_COMPLETED'
	)),
	CONSTRAINT "rider_order_assignments_seq_ck" CHECK ("delivery_sequence" >= 1),
	CONSTRAINT "rider_order_assignments_lat_ck" CHECK ("delivery_lat" >= -90 AND "delivery_lat" <= 90),
	CONSTRAINT "rider_order_assignments_lng_ck" CHECK ("delivery_lng" >= -180 AND "delivery_lng" <= 180)
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_order_assignments_open_order_uq"
	ON "rider_order_assignments" USING btree ("order_id")
	WHERE "status" <> 'FULFILLMENT_COMPLETED';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_order_assignments_rider_status_idx"
	ON "rider_order_assignments" USING btree ("rider_user_id", "status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_order_assignments_rider_seq_idx"
	ON "rider_order_assignments" USING btree ("rider_user_id", "delivery_sequence");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rider_pod_images" (
	"id" serial PRIMARY KEY NOT NULL,
	"assignment_id" integer NOT NULL,
	"storage_key" varchar(256) NOT NULL,
	"content_type" varchar(64) NOT NULL,
	"size_bytes" integer NOT NULL,
	"uploaded_by_user_id" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rider_pod_images_assignment_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."rider_order_assignments"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "rider_pod_images_uploaded_by_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action,
	CONSTRAINT "rider_pod_images_size_ck" CHECK ("size_bytes" > 0 AND "size_bytes" <= 5242880),
	CONSTRAINT "rider_pod_images_key_ck" CHECK ("storage_key" LIKE 'rider-pod/%')
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_pod_images_assignment_idx" ON "rider_pod_images" USING btree ("assignment_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rider_pod_images_storage_key_uq" ON "rider_pod_images" USING btree ("storage_key");--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "rider_location_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"rider_user_id" uuid NOT NULL,
	"assignment_id" integer,
	"kind" varchar(32) DEFAULT 'ARRIVAL' NOT NULL,
	"latitude" double precision NOT NULL,
	"longitude" double precision NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"distance_meters" double precision,
	CONSTRAINT "rider_location_events_rider_fk" FOREIGN KEY ("rider_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "rider_location_events_assignment_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."rider_order_assignments"("id") ON DELETE set null ON UPDATE no action,
	CONSTRAINT "rider_location_events_kind_ck" CHECK ("kind" IN ('ARRIVAL', 'SAMPLE')),
	CONSTRAINT "rider_location_events_lat_ck" CHECK ("latitude" >= -90 AND "latitude" <= 90),
	CONSTRAINT "rider_location_events_lng_ck" CHECK ("longitude" >= -180 AND "longitude" <= 180)
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rider_location_events_rider_recorded_idx"
	ON "rider_location_events" USING btree ("rider_user_id", "recorded_at");
