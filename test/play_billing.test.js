// Google Play subscriptions → billing/{uid}, and the guard that stops a
// lapsed plan in one store wiping a running one in the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import { playToBilling } from "../play_billing.js";
import { mayReplace } from "../billing.js";

const future = new Date(Date.now() + 20 * 24 * 3600 * 1000);
const past = new Date(Date.now() - 24 * 3600 * 1000);
const ts = (d) => ({ toDate: () => d });

const sub = (state, { product = "premium_yearly", expiry = future, renews = true, extra = {} } = {}) => ({
  subscriptionState: state,
  lineItems: [
    { productId: product, expiryTime: expiry.toISOString(), autoRenewingPlan: { autoRenewEnabled: renews } },
  ],
  externalAccountIdentifiers: { obfuscatedExternalAccountId: "uid123" },
  acknowledgementState: "ACKNOWLEDGEMENT_STATE_PENDING",
  ...extra,
});

test("active Play subscription is a paid plan", () => {
  const p = playToBilling(sub("SUBSCRIPTION_STATE_ACTIVE"));
  assert.equal(p.status, "active");
  assert.equal(p.plan, "yearly");
  assert.equal(p.periodEnd.getTime(), future.getTime());
  assert.equal(p.cancelAtPeriodEnd, false);
  assert.equal(p.accountId, "uid123");
  assert.equal(p.needsAck, true);
});

test("cancelled keeps Premium to the end; grace period still counts", () => {
  const c = playToBilling(sub("SUBSCRIPTION_STATE_CANCELED", { renews: false, product: "premium_monthly" }));
  assert.equal(c.status, "active");
  assert.equal(c.cancelAtPeriodEnd, true);
  assert.equal(c.plan, "monthly");
  assert.equal(playToBilling(sub("SUBSCRIPTION_STATE_IN_GRACE_PERIOD")).status, "past_due");
});

test("on hold, expired, pending and unknown are not paid", () => {
  for (const [state, status] of [
    ["SUBSCRIPTION_STATE_ON_HOLD", "on_hold"],
    ["SUBSCRIPTION_STATE_EXPIRED", "expired"],
    ["SUBSCRIPTION_STATE_PENDING", "pending"],
    ["SOMETHING_NEW", "expired"],
  ]) {
    assert.equal(playToBilling(sub(state)).status, status);
  }
  assert.equal(playToBilling(sub("SUBSCRIPTION_STATE_ACTIVE", { product: "coins" })).plan, null);
  assert.equal(playToBilling({}).periodEnd, null);
});

test("a lapsed plan in one store doesn't wipe a running one in the other", () => {
  const runningPlay = { store: "play", status: "active", current_period_end: ts(future) };
  assert.equal(mayReplace(runningPlay, "stripe", false), false);
  assert.equal(mayReplace(runningPlay, "stripe", true), true, "a new paid plan wins");
  assert.equal(mayReplace(runningPlay, "play", false), true, "same store: always");
  const lapsedPlay = { store: "play", status: "active", current_period_end: ts(past) };
  assert.equal(mayReplace(lapsedPlay, "stripe", false), true);
  // Older Stripe documents have no store field.
  const runningStripe = { stripe_subscription_id: "sub_1", status: "active", current_period_end: ts(future) };
  assert.equal(mayReplace(runningStripe, "play", false), false);
  assert.equal(mayReplace({}, "play", false), true);
});
