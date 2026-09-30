-- Existing organizations keep their current approval workflow. Super Admins
-- can opt individual tenants into immediate approval for future orders.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS order_approval_required boolean NOT NULL DEFAULT true;
