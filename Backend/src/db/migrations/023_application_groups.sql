-- Downstream Hub — application groups for the user dashboard (idempotent)
--
-- Admins sort applications into named groups (e.g. "Logistics", "Finance") and set the order
-- of the groups and of the applications inside each one. The user dashboard shows apps by
-- group, in that order. Department visibility is unchanged: a group only shows the apps the
-- user may see, and a group with none of them is hidden.

CREATE TABLE IF NOT EXISTS application_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(60) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_application_groups_name ON application_groups (lower(name));

-- One group per application (NULL = ungrouped). sort_order is the position inside the group;
-- new applications start at the end (1000000) until an admin arranges them.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES application_groups(id) ON DELETE SET NULL;
ALTER TABLE applications ADD COLUMN IF NOT EXISTS sort_order INT NOT NULL DEFAULT 1000000;
CREATE INDEX IF NOT EXISTS idx_applications_group ON applications (group_id, sort_order);
