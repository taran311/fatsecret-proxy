import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signedByStripe, grantFor } from "../bowbound.js";

const secret = "whsec_test";
const body = Buffer.from(JSON.stringify({ type: "checkout.session.completed" }));
const now = 1_800_000_000_000;
const t = Math.floor(now / 1000);
const sign = (b, s = secret, at = t) => `t=${at},v1=${createHmac("sha256", s).update(`${at}.`).update(b).digest("hex")}`;

test("accepts a body Stripe signed", () => {
  assert.equal(signedByStripe(body, sign(body), secret, now), true);
});

test("rejects a wrong secret, a changed body, an old or missing signature", () => {
  assert.equal(signedByStripe(body, sign(body, "other"), secret, now), false);
  assert.equal(signedByStripe(Buffer.from("{}"), sign(body), secret, now), false);
  assert.equal(signedByStripe(body, sign(body, secret, t - 301), secret, now), false);
  assert.equal(signedByStripe(body, "", secret, now), false);
  assert.equal(signedByStripe(body, "t=abc,v1=zz", secret, now), false);
  assert.equal(signedByStripe(body, sign(body), "", now), false);
});

const paid = (over = {}) => ({
  type: "checkout.session.completed",
  livemode: true,
  data: { object: { id: "cs_1", payment_status: "paid", client_reference_id: "abcDEF123456", ...over } },
});

test("grants the account on a paid checkout", () => {
  assert.deepEqual(grantFor(paid()), { uid: "abcDEF123456", session: "cs_1", livemode: true });
});

test("skips other events, unpaid sessions and checkouts with no account", () => {
  assert.equal(grantFor({ type: "invoice.paid", data: { object: {} } }).skip, "ignored");
  assert.equal(grantFor(paid({ payment_status: "unpaid" })).skip, "not paid yet");
  assert.equal(grantFor(paid({ client_reference_id: null })).skip, "no account");
  assert.equal(grantFor(paid({ client_reference_id: "../grants/x" })).skip, "no account");
});
