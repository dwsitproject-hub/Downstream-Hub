-- Downstream Hub — attribute anonymous SDK sessions to the person who signs in next (idempotent)
--
-- An app's SDK knows a user only after identify(). When an app restores a signed-in user
-- without calling it (or the call is lost, or the tab predates the SDK), that person's
-- activity is recorded under the browser's anonymous id and is missing from "Most active
-- users" (TAS, 3 Nov 2026). The collector now attributes such sessions when the browser next
-- identifies (sdkDb.attributeAnonymousSessions). This does the same for sessions recorded
-- before that change, by the same rule:
--   an anonymous session belongs to the FIRST identified session that follows it in the same
--   browser (same app, same anonymous id) within 14 days.
-- A shared PC is respected: the session goes to the next person who signed in, never to an
-- earlier one. Runs on every start; once a session is attributed it no longer matches.

CREATE INDEX IF NOT EXISTS idx_app_sessions_app_anon
  ON app_sessions(application_id, anonymous_id, started_at);

WITH attributed AS (
  UPDATE app_sessions a
  SET user_id = nx.user_id, user_email = nx.user_email
  FROM (
    SELECT a2.id, n.user_id, n.user_email
    FROM app_sessions a2
    CROSS JOIN LATERAL (
      SELECT o.user_id, o.user_email
      FROM app_sessions o
      WHERE o.application_id = a2.application_id
        AND o.anonymous_id = a2.anonymous_id
        AND o.started_at > a2.started_at
        AND o.started_at <= a2.started_at + interval '14 days'
        AND (o.user_id IS NOT NULL OR o.user_email IS NOT NULL)
      ORDER BY o.started_at
      LIMIT 1
    ) n
    WHERE a2.user_id IS NULL AND a2.user_email IS NULL
      AND a2.anonymous_id IS NOT NULL
      AND a2.started_at >= now() - interval '90 days'
  ) nx
  WHERE a.id = nx.id
  RETURNING a.application_id, a.session_key, a.user_id, a.user_email
)
UPDATE app_events e
SET user_id = attributed.user_id, user_email = attributed.user_email
FROM attributed
WHERE e.application_id = attributed.application_id
  AND e.session_key = attributed.session_key
  AND e.user_id IS NULL AND e.user_email IS NULL;
