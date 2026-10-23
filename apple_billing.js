// Premium bought in the iPhone app, through the App Store.
//
// Apple doesn't let iPhone apps sell subscriptions through Stripe, so the
// app buys with StoreKit 2 and this server checks every purchase before
// giving Premium. The result goes into the same billing/{uid} document as
// Stripe and Google Play, so the rest of the app doesn't care where
// someone paid.
//
//   POST /billing/apple/verify { productId, signedTransaction }  (signed in)
//        The app calls this straight after a purchase or a restore, with
//        StoreKit 2's signed transaction (a JWS).
//   POST /billing/apple/notifications { signedPayload }           (Apple)
//        App Store Server Notifications V2: renewals, cancellations,
//        billing problems, refunds and expiry.
//
// Everything Apple sends is a JWS signed by a certificate chain that ends
// at Apple Root CA - G3. We check the chain (each certificate signed by the
// next, Apple's markers on the leaf and intermediate, all in date), that
// the root is Apple's real one (downloaded from apple.com once, or given
// in APPLE_ROOT_CA_B64), and the signature itself. Same checks as Apple's
// own app-store-server-library, without the dependency.
//
// Apple only accepts a UUID as the purchase's account id, so purchases are
// linked by their original transaction id instead: the first account to
// send one owns it, and nobody else can claim it.
//
// Extra fields on billing/{uid}: store ('apple'), apple_product_id,
// apple_original_transaction_id, apple_environment.
//
// Env:
//   APPLE_BUNDLE_ID (com.thecaloriecard.app)
//   APPLE_ROOT_CA_B64 (optional): Apple Root CA - G3 as base64 DER, to skip
//     the download.
//
// App Store Connect → the app → App information → App Store Server
// Notifications: set both URLs (production and sandbox) to
// https://<this server>/billing/apple/notifications, Version 2.

import { X509Certificate, verify as verifySignature } from "node:crypto";
import axios from "axios";
import bodyParser from "body-parser";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { entitlementFrom, mirrorPremium, mayReplace } from "./billing.js";

const BUNDLE_ID = process.env.APPLE_BUNDLE_ID || "com.thecaloriecard.app";
const ROOT_URL = "https://www.apple.com/certificateauthority/AppleRootCA-G3.cer";

/** App Store product id → our plan name (both names are accepted). */
export const APPLE_PRODUCTS = {
  monthly: "monthly",
  yearly: "yearly",
  premium_monthly: "monthly",
  premium_yearly: "yearly",
};

const PAID_STATES = new Set(["active", "trialing", "past_due"]);

let enabled = false;

const db = () => getFirestore();
const billingRef = (uid) => db().collection("billing").doc(uid);

// -------------------- Checking Apple's signatures --------------------

// Apple's markers (certificate extensions): 1.2.840.113635.100.6.11.1 on
// the leaf that signs App Store data, 1.2.840.113635.100.6.2.1 on the
// Apple Worldwide Developer Relations intermediate. As DER bytes.
const LEAF_OID = Buffer.from("060a2a864886f76364060b01", "hex");
const INTERMEDIATE_OID = Buffer.from("060a2a864886f763640602 01".replace(/ /g, ""), "hex");

/** Whether certificate [der] contains the extension OID [oid]. */
export function hasOid(der, oid) {
  return Buffer.from(der).indexOf(oid) !== -1;
}

let rootPromise = null;

/** Apple Root CA - G3 (DER), from the env or apple.com, cached. */
function appleRoot() {
  if (process.env.APPLE_ROOT_CA_B64) {
    return Promise.resolve(Buffer.from(process.env.APPLE_ROOT_CA_B64, "base64"));
  }
  rootPromise ??= axios
    .get(ROOT_URL, { responseType: "arraybuffer", timeout: 15000 })
    .then((r) => Buffer.from(r.data))
    .catch((err) => {
      rootPromise = null; // try again next time
      throw err;
    });
  return rootPromise;
}

const b64urlJson = (part) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * Checks a JWS's ES256 signature with [publicKey] (raw r‖s, as JWS uses).
 * Exported for tests.
 */
export function jwsSignatureOk(jws, publicKey) {
  const [h, p, s] = String(jws).split(".");
  if (!h || !p || !s) return false;
  try {
    return verifySignature(
      "sha256",
      Buffer.from(`${h}.${p}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url")
    );
  } catch (_) {
    return false;
  }
}

/** Thrown when Apple's data doesn't check out. */
export class AppleVerifyError extends Error {}

/**
 * The payload of a JWS from Apple, once everything checks out. Throws
 * [AppleVerifyError] otherwise. [rootDer] defaults to Apple's real root.
 */
export async function verifyAppleJws(jws, { rootDer, now = new Date() } = {}) {
  const parts = String(jws || "").split(".");
  if (parts.length !== 3) throw new AppleVerifyError("Not a signed Apple message");
  let header;
  try {
    header = b64urlJson(parts[0]);
  } catch (_) {
    throw new AppleVerifyError("Unreadable header");
  }
  if (header.alg !== "ES256") throw new AppleVerifyError("Unexpected signature type");
  const chain = Array.isArray(header.x5c) ? header.x5c : [];
  if (chain.length !== 3) throw new AppleVerifyError("Unexpected certificate chain");
  let leaf, intermediate, root;
  try {
    [leaf, intermediate, root] = chain.map((c) => new X509Certificate(Buffer.from(c, "base64")));
  } catch (_) {
    throw new AppleVerifyError("Unreadable certificate");
  }
  const expectedRoot = rootDer || (await appleRoot());
  if (!root.raw.equals(Buffer.from(expectedRoot))) {
    throw new AppleVerifyError("Not signed by Apple");
  }
  if (!leaf.verify(intermediate.publicKey) || !intermediate.verify(root.publicKey)) {
    throw new AppleVerifyError("Broken certificate chain");
  }
  if (!hasOid(leaf.raw, LEAF_OID) || !hasOid(intermediate.raw, INTERMEDIATE_OID)) {
    throw new AppleVerifyError("Not an App Store certificate");
  }
  for (const c of [leaf, intermediate, root]) {
    if (now < new Date(c.validFrom) || now > new Date(c.validTo)) {
      throw new AppleVerifyError("Certificate out of date");
    }
  }
  if (!jwsSignatureOk(jws, leaf.publicKey)) throw new AppleVerifyError("Bad signature");
  try {
    return b64urlJson(parts[1]);
  } catch (_) {
    throw new AppleVerifyError("Unreadable payload");
  }
}

// -------------------- Apple's answer → billing/{uid} --------------------

/**
 * What an App Store transaction (and, from a notification, its renewal
 * info) means for billing/{uid}: status (as Stripe names them, so
 * entitlementFrom works), plan, the end of the paid period and whether it
 * renews. Exported for tests.
 */
export function appleToBilling(tx, renewal = null, now = new Date()) {
  const productId = String(tx?.productId || "");
  const expires = Number(tx?.expiresDate) ? new Date(Number(tx.expiresDate)) : null;
  const grace = Number(renewal?.gracePeriodExpiresDate)
    ? new Date(Number(renewal.gracePeriodExpiresDate))
    : null;
  let status;
  let periodEnd = expires;
  if (tx?.revocationDate) {
    status = "expired"; // refunded or revoked
  } else if (expires && expires > now) {
    status = "active";
  } else if (renewal?.isInBillingRetryPeriod && grace && grace > now) {
    // Apple is retrying the payment in its grace period: keep Premium.
    status = "past_due";
    periodEnd = grace;
  } else {
    status = "expired";
  }
  return {
    status,
    plan: APPLE_PRODUCTS[productId] || null,
    productId,
    periodEnd,
    cancelAtPeriodEnd: renewal ? Number(renewal.autoRenewStatus) === 0 : false,
    originalTransactionId: String(tx?.originalTransactionId || ""),
    environment: String(tx?.environment || ""),
    bundleId: String(tx?.bundleId || ""),
  };
}

const isPaid = (status, periodEnd, now = new Date()) =>
  PAID_STATES.has(status) && !!periodEnd && periodEnd.getTime() > now.getTime();

/** The account an original transaction belongs to, from what we've stored. */
async function uidForOriginal(originalTransactionId) {
  if (!originalTransactionId) return null;
  const snap = await db()
    .collection("billing")
    .where("apple_original_transaction_id", "==", originalTransactionId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

/** Copies an App Store subscription onto billing/{uid}. */
async function syncApple(uid, a) {
  const data = await db().runTransaction(async (tx) => {
    const ref = billingRef(uid);
    const current = (await tx.get(ref)).data() || {};
    // An older transaction of the same subscription mustn't undo a newer
    // one (a restore can send the whole history).
    const knownEnd = current.current_period_end?.toDate?.();
    if (
      current.store === "apple" &&
      current.apple_original_transaction_id === a.originalTransactionId &&
      knownEnd &&
      a.periodEnd &&
      a.periodEnd < knownEnd &&
      a.status !== "expired"
    ) {
      return current;
    }
    if (!mayReplace(current, "apple", isPaid(a.status, a.periodEnd))) return current;
    const update = {
      store: "apple",
      status: a.status,
      plan: a.plan,
      current_period_end: a.periodEnd ? Timestamp.fromDate(a.periodEnd) : null,
      cancel_at_period_end: a.cancelAtPeriodEnd,
      apple_product_id: a.productId || null,
      apple_original_transaction_id: a.originalTransactionId || null,
      apple_environment: a.environment || null,
      updated_at: FieldValue.serverTimestamp(),
    };
    tx.set(ref, update, { merge: true });
    return { ...current, ...update };
  });
  await mirrorPremium(uid, data);
  return data;
}

// -------------------- Routes --------------------

export function registerAppleBilling(app, { requireFirebaseUser, firestoreReady }) {
  enabled = !!firestoreReady;
  console.log(`[apple] App Store billing ${enabled ? "on" : "off"} (${BUNDLE_ID})`);

  // The app, straight after a purchase (or "Restore purchases").
  app.post("/billing/apple/verify", requireFirebaseUser, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first" });
    if (!enabled) {
      return res.status(503).json({ error: "Payments aren't set up yet. Try again soon." });
    }
    const signed = String(req.body?.signedTransaction || "").trim();
    if (!signed || signed.length > 16384) {
      return res.status(400).json({ error: "Missing purchase" });
    }
    let tx;
    try {
      tx = await verifyAppleJws(signed);
    } catch (err) {
      if (err instanceof AppleVerifyError) {
        console.warn("[apple] verify rejected:", err.message);
        return res.status(400).json({ error: "The App Store doesn't recognise that purchase." });
      }
      console.warn("[apple] couldn't check:", err.message);
      return res.status(502).json({ error: "Couldn't check with the App Store. Try again?" });
    }
    try {
      const a = appleToBilling(tx);
      if (a.bundleId !== BUNDLE_ID) {
        return res.status(400).json({ error: "That purchase isn't for this app." });
      }
      if (!a.plan) return res.status(400).json({ error: "That isn't a Premium plan." });
      if (!a.originalTransactionId) return res.status(400).json({ error: "Missing purchase" });
      const owner = await uidForOriginal(a.originalTransactionId);
      if (owner && owner !== uid) {
        return res.status(403).json({ error: "That purchase belongs to another account." });
      }
      const data = await syncApple(uid, a);
      const e = entitlementFrom(data);
      return res.json({ premium: e.premium, subscribed: e.subscribed, plan: a.plan, status: a.status });
    } catch (err) {
      console.error("[apple] verify failed:", err.message);
      return res.status(500).json({ error: "Something went wrong. Try again?" });
    }
  });

  // Apple → us. Apple retries anything that isn't a 2xx, which is what we
  // want when something went wrong on our side.
  app.post("/billing/apple/notifications", bodyParser.json({ limit: "256kb" }), async (req, res) => {
    if (!enabled) return res.status(503).send("Not configured");
    let note;
    try {
      note = await verifyAppleJws(req.body?.signedPayload);
    } catch (err) {
      if (err instanceof AppleVerifyError) {
        console.warn("[apple] notification rejected:", err.message);
        return res.status(400).send("Bad signature");
      }
      console.warn("[apple] couldn't check notification:", err.message);
      return res.status(500).send("Retry");
    }
    try {
      const d = note?.data || {};
      if (d.bundleId && d.bundleId !== BUNDLE_ID) return res.status(200).end();
      if (!d.signedTransactionInfo) return res.status(200).end(); // e.g. TEST
      const tx = await verifyAppleJws(d.signedTransactionInfo);
      const renewal = d.signedRenewalInfo ? await verifyAppleJws(d.signedRenewalInfo) : null;
      const a = appleToBilling(tx, renewal);
      if (!a.plan) return res.status(200).end();
      const uid = await uidForOriginal(a.originalTransactionId);
      if (!uid) {
        console.warn(`[apple] ${note.notificationType} for a purchase with no account yet`);
        return res.status(200).end(); // the app's verify call will catch it
      }
      await syncApple(uid, a);
      return res.status(200).end();
    } catch (err) {
      if (err instanceof AppleVerifyError) return res.status(400).send("Bad signature");
      console.error("[apple] notification failed:", err.message);
      return res.status(500).send("Retry");
    }
  });
}
