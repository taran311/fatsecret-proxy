import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { signedByStripe, grantFor, isBowboundAdmin, newCode, normaliseCode, displayCode, playGrantFor } from "../bowbound.js";

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

test("gift codes survive being typed loosely, and bad ones are refused", () => {
  const code = newCode();
  assert.equal(code.length, 8);
  assert.equal(normaliseCode(displayCode(code)), code);
  assert.equal(normaliseCode(` ${displayCode(code).toLowerCase().replace(/-/g, " ")} `), code);
  assert.equal(normaliseCode(code), code);
  assert.equal(normaliseCode("BOW-0000-0000"), null); // 0 isn't in the alphabet
  assert.equal(normaliseCode("BOW-7KQ2"), null);
  assert.equal(normaliseCode(""), null);
});

test("only the listed, verified emails are admins", () => {
  const u = (email, emailVerified = true) => ({ uid: "x", email, emailVerified });
  assert.equal(isBowboundAdmin(u("vegthetics@gmail.com"), ""), true);
  assert.equal(isBowboundAdmin(u("VegtheticsBodybuilding@Gmail.com"), ""), true);
  assert.equal(isBowboundAdmin(u("taz_dh@hotmail.com"), ""), true);
  assert.equal(isBowboundAdmin(u("taz_dh@hotmail.com", false), ""), false); // unverified
  assert.equal(isBowboundAdmin(u("someone@else.com"), ""), false);
  assert.equal(isBowboundAdmin(null, ""), false);
  assert.equal(isBowboundAdmin(u("vegthetics@gmail.com"), "other@x.com"), false); // the setting replaces the list
  assert.equal(isBowboundAdmin(u("other@x.com"), "other@x.com"), true);
});

test("a Google Play purchase unlocks only when paid, and only for its own account", () => {
  const bought = { purchaseState: 0, acknowledgementState: 0, orderId: "GPA.1", obfuscatedExternalAccountId: "uidA" };
  assert.deepEqual(playGrantFor(bought, "uidA"), { ok: true, orderId: "GPA.1", needsAck: true });
  assert.equal(playGrantFor({ ...bought, acknowledgementState: 1 }, "uidA").needsAck, false);
  assert.equal(playGrantFor({ ...bought, obfuscatedExternalAccountId: undefined }, "uidB").ok, true); // untagged: allowed
  assert.equal(playGrantFor(bought, "uidB").status, 409); // someone else's
  assert.equal(playGrantFor({ ...bought, purchaseState: 2 }, "uidA").status, 409); // pending
  assert.equal(playGrantFor({ ...bought, purchaseState: 1 }, "uidA").status, 410); // refunded
  assert.equal(playGrantFor(null, "uidA").status, 404);
});
