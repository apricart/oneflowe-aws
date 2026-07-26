# Order lifecycle notifications

Order lifecycle communication is tenant- and branch-scoped and applies only to
orders created by a user whose current database role is `ORDER_PORTAL`.

## Events and recipients

- `ORDER_CREATED`: every active, non-deleted `BRANCH_ADMIN` assigned to the
  order's exact organization and branch.
- `ORDER_APPROVED` and `ORDER_REJECTED`: the active, non-deleted
  `ORDER_PORTAL` user recorded in `orders.created_by_user_id`, provided their
  current organization and branch still match the order.
- `ORDER_APPROVED_ADMIN`: every active, non-deleted `SUPER_ADMIN`, but only
  when the successful approver is an active `BRANCH_ADMIN` assigned to the
  order's exact organization and branch. Head Office or Super Admin approvals
  do not generate this additional event.

Recipient IDs are never accepted from an HTTP request. The application resolves
them from the database inside the order transaction, then revalidates current
role and scope immediately before email delivery.

## Delivery guarantees

The business transition, in-app notification, and email outbox record commit in
one database transaction. A unique event key prevents request replays from
creating a second notification or outbox entry. SES is called only after commit,
one recipient at a time. Failed calls remain in `email_outbox` for bounded retry;
they never roll back a created, approved, or rejected order.

Email messages intentionally exclude approval/fulfillment tokens and monetary
values. All HTML template values are escaped, and links are built from the
validated `NEXTAUTH_URL`.

## Deployment order

1. Apply `drizzle/20260721120000_add_order_notification_outbox.sql` with the
   normal migration workflow before deploying the application build.
2. Deploy the application with valid AWS SES runtime configuration.
3. Deploy `infra/email-outbox-scheduler.yml` as a separate CloudFormation stack,
   passing the application URL and the same `CRON_SECRET` configured in the app.
4. Confirm the EventBridge rule invokes
   `POST /api/v1/notifications/email-outbox/process` every minute.

The API attempts immediate delivery after each committed event. The schedule is
still required so temporary SES/network failures are retried.
