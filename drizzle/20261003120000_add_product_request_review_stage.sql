-- New-product requests gain an "Under review" stage and an expected
-- availability date on approval.
-- See plans/OF-PRODUCT-REQUEST-review-stage-and-availability-date.md.
--
-- Three nullable columns on a small, days-old table; two CHECKs recreated and
-- two added. Every existing row satisfies the new constraints: none is
-- UNDER_REVIEW, none has a review start or a date.
--
--   * review_started_at / review_started_by_user_id — who put the request
--     under review and when. Both null while PENDING, both set while
--     UNDER_REVIEW, set together or not at all once decided.
--   * estimated_available_on — the day Super Admin expects the product in the
--     catalogue. Only an APPROVED row may carry one; the API requires it on
--     every new approval, and approvals made before this migration keep null.
--
-- Rollback (after moving any UNDER_REVIEW row back to PENDING and clearing its
-- review-start fields):
--   ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_availability_ck";
--   ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_review_start_ck";
--   ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_review_ck";
--   ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_status_ck";
--   ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_status_ck" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'));
--   ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_review_ck" CHECK (CASE WHEN "status" = 'PENDING'
--     THEN "reviewed_at" IS NULL AND "reviewed_by_user_id" IS NULL AND "review_note" IS NULL
--     ELSE "reviewed_at" IS NOT NULL AND "reviewed_by_user_id" IS NOT NULL END);
--   ALTER TABLE "product_requests" DROP COLUMN "estimated_available_on";
--   ALTER TABLE "product_requests" DROP COLUMN "review_started_by_user_id";
--   ALTER TABLE "product_requests" DROP COLUMN "review_started_at";

ALTER TABLE "product_requests" ADD COLUMN "review_started_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "product_requests" ADD COLUMN "review_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_requests" ADD COLUMN "estimated_available_on" date;--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_review_started_by_user_id_users_id_fk" FOREIGN KEY ("review_started_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_status_ck";--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_status_ck" CHECK ("product_requests"."status" IN ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED'));--> statement-breakpoint
ALTER TABLE "product_requests" DROP CONSTRAINT "product_requests_review_ck";--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_review_ck" CHECK (CASE WHEN "product_requests"."status" IN ('PENDING', 'UNDER_REVIEW')
            THEN "product_requests"."reviewed_at" IS NULL AND "product_requests"."reviewed_by_user_id" IS NULL AND "product_requests"."review_note" IS NULL
            ELSE "product_requests"."reviewed_at" IS NOT NULL AND "product_requests"."reviewed_by_user_id" IS NOT NULL
          END);--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_review_start_ck" CHECK (CASE "product_requests"."status"
            WHEN 'PENDING' THEN "product_requests"."review_started_at" IS NULL AND "product_requests"."review_started_by_user_id" IS NULL
            WHEN 'UNDER_REVIEW' THEN "product_requests"."review_started_at" IS NOT NULL AND "product_requests"."review_started_by_user_id" IS NOT NULL
            ELSE ("product_requests"."review_started_at" IS NULL) = ("product_requests"."review_started_by_user_id" IS NULL)
          END);--> statement-breakpoint
ALTER TABLE "product_requests" ADD CONSTRAINT "product_requests_availability_ck" CHECK ("product_requests"."estimated_available_on" IS NULL OR "product_requests"."status" = 'APPROVED');
