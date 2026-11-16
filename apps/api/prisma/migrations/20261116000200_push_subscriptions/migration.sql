-- One row per browser signed up for notifications.
--
-- Per browser, not per person. The same person on a phone and on a laptop is
-- two subscriptions, and turning notifications off on the laptop must not
-- silence the phone.
--
-- `endpoint` is the push service's own URL for that browser, so it is unique
-- by definition. Making the database say so is what lets the app re-save an
-- unchanged subscription on every sign-in without piling up duplicates - a
-- browser may hand back the same subscription it had, and it may equally hand
-- back a new one after the old was revoked.
--
-- Nothing stored here is a secret of ours. `p256dh` and `auth` are the
-- browser's own public key and auth secret; they let the server encrypt a
-- payload only that browser can decrypt, which is the whole point of the
-- scheme. A stolen copy of this table would let nobody read anything.
--
-- Rows are deleted outright rather than soft-deleted, which is the exception
-- in this schema. A dead endpoint is not history anybody wants: the push
-- service reports it as gone, and the honest response is to stop holding it.
CREATE TABLE "push_subscription" (
  "id"        UUID         NOT NULL,
  "userId"    UUID         NOT NULL,
  "endpoint"  TEXT         NOT NULL,
  "p256dh"    TEXT         NOT NULL,
  "auth"      TEXT         NOT NULL,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastOkAt"  TIMESTAMPTZ(6),
  "failures"  INTEGER      NOT NULL DEFAULT 0,

  CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "push_subscription_endpoint_key" ON "push_subscription"("endpoint");
CREATE INDEX "push_subscription_userId_idx" ON "push_subscription"("userId");

-- Signing a person out of everything should take their notifications with it.
ALTER TABLE "push_subscription"
  ADD CONSTRAINT "push_subscription_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
