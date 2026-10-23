// App Store purchases → billing/{uid}, and the signature checks on what
// Apple sends. The certificates in apple_test_certs.json are test-only
// ones shaped like Apple's chain (root → WWDR intermediate → signing leaf,
// with Apple's markers), so the whole check runs without Apple.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  appleToBilling,
  verifyAppleJws,
  jwsSignatureOk,
  hasOid,
  AppleVerifyError,
} from "../apple_billing.js";

const certs = JSON.parse(readFileSync(new URL("./apple_test_certs.json", import.meta.url), "utf8"));
const rootDer = Buffer.from(certs.root, "base64");
const leafKey = createPrivateKey(certs.leafKey);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

/** A JWS signed like Apple's, with [x5c] as the chain. */
function jws(payload, { x5c = [certs.leaf, certs.intermediate, certs.root], key = leafKey, alg = "ES256" } = {}) {
  const head = `${b64({ alg, x5c })}.${b64(payload)}`;
  const sig = sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" });
  return `${head}.${sig.toString("base64url")}`;
}

const future = Date.now() + 20 * 24 * 3600 * 1000;
const past = Date.now() - 24 * 3600 * 1000;
const tx = (extra = {}) => ({
  bundleId: "com.thecaloriecard.app",
  productId: "premium_yearly",
  originalTransactionId: "2000000123",
  transactionId: "2000000456",
  expiresDate: future,
  environment: "Sandbox",
  type: "Auto-Renewable Subscription",
  ...extra,
});

test("a correctly signed transaction is accepted", async () => {
  const p = await verifyAppleJws(jws(tx()), { rootDer });
  assert.equal(p.productId, "premium_yearly");
  assert.equal(p.originalTransactionId, "2000000123");
});

test("a chain that doesn't end at Apple's root is refused", async () => {
  await assert.rejects(
    verifyAppleJws(jws(tx(), { x5c: [certs.leaf, certs.intermediate, certs.otherRoot] }), { rootDer }),
    AppleVerifyError
  );
});

test("a leaf without Apple's App Store marker is refused", async () => {
  await assert.rejects(
    verifyAppleJws(jws(tx(), { x5c: [certs.plainLeaf, certs.intermediate, certs.root] }), { rootDer }),
    AppleVerifyError
  );
});

test("a changed payload fails the signature", async () => {
  const [h, , s] = jws(tx()).split(".");
  const forged = `${h}.${b64(tx({ productId: "premium_yearly", expiresDate: future * 2 }))}.${s}`;
  await assert.rejects(verifyAppleJws(forged, { rootDer }), AppleVerifyError);
});

test("wrong algorithm, missing chain or junk is refused", async () => {
  await assert.rejects(verifyAppleJws(jws(tx(), { alg: "HS256" }), { rootDer }), AppleVerifyError);
  await assert.rejects(verifyAppleJws(jws(tx(), { x5c: [certs.leaf] }), { rootDer }), AppleVerifyError);
  await assert.rejects(verifyAppleJws("not.a.jws", { rootDer }), AppleVerifyError);
  await assert.rejects(verifyAppleJws("", { rootDer }), AppleVerifyError);
});

test("jwsSignatureOk and hasOid", () => {
  const good = jws(tx());
  assert.equal(jwsSignatureOk(good, createPrivateKey(certs.leafKey)), true);
  assert.equal(jwsSignatureOk(good.slice(0, -4) + "AAAA", createPrivateKey(certs.leafKey)), false);
  const leafOid = Buffer.from("060a2a864886f76364060b01", "hex");
  assert.equal(hasOid(Buffer.from(certs.leaf, "base64"), leafOid), true);
  assert.equal(hasOid(Buffer.from(certs.plainLeaf, "base64"), leafOid), false);
});

test("an active App Store subscription is a paid plan", () => {
  const a = appleToBilling(tx());
  assert.equal(a.status, "active");
  assert.equal(a.plan, "yearly");
  assert.equal(a.periodEnd.getTime(), future);
  assert.equal(a.cancelAtPeriodEnd, false);
  assert.equal(a.originalTransactionId, "2000000123");
  assert.equal(appleToBilling(tx({ productId: "monthly" })).plan, "monthly");
  assert.equal(appleToBilling(tx({ productId: "coins" })).plan, null);
});

test("turned off renewing: still paid to the end of the period", () => {
  const a = appleToBilling(tx(), { autoRenewStatus: 0 });
  assert.equal(a.status, "active");
  assert.equal(a.cancelAtPeriodEnd, true);
});

test("billing retry in the grace period keeps Premium; after it, expired", () => {
  const graceEnd = Date.now() + 3 * 24 * 3600 * 1000;
  const g = appleToBilling(tx({ expiresDate: past }), {
    isInBillingRetryPeriod: true,
    gracePeriodExpiresDate: graceEnd,
    autoRenewStatus: 1,
  });
  assert.equal(g.status, "past_due");
  assert.equal(g.periodEnd.getTime(), graceEnd);
  const e = appleToBilling(tx({ expiresDate: past }), { isInBillingRetryPeriod: true });
  assert.equal(e.status, "expired");
});

test("refunded or revoked ends Premium straight away", () => {
  assert.equal(appleToBilling(tx({ revocationDate: Date.now() })).status, "expired");
});

test("lapsed is expired", () => {
  assert.equal(appleToBilling(tx({ expiresDate: past })).status, "expired");
});
