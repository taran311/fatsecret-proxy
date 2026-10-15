// Premium bought in the Android app, through Google Play.
//
// Google doesn't let Android apps sell subscriptions through Stripe, so the
// app buys with Google Play Billing and this server checks every purchase
// with Google before giving Premium. The result goes into the same
// billing/{uid} document as Stripe, so the rest of the app doesn't care
// where someone paid.
//
//   POST /billing/play/verify { productId, purchaseToken }   (signed in)
//        The app calls this straight after a purchase or a restore.
//   POST /billing/play/rtdn?token=…                           (Google)
//        Google's renewal / cancellation / expiry messages (Real-time
//        developer notifications, pushed by Pub/Sub).
//
// Extra fields on billing/{uid}: store ('play' or 'stripe'),
// play_product_id, play_purchase_token.
//
// The app sets the purchase's account id to the Firebase uid, so Google
// tells us whose purchase it is and a token can't be claimed by someone
// else.
//
// Env:
//   FIREBASE_SERVICE_ACCOUNT (already used) or PLAY_SERVICE_ACCOUNT: a
//     service account invited in Play Console (Users and permissions) with
//     "View financial data" and "Manage orders and subscriptions", in a
//     Google Cloud project with the Google Play Android Developer API on.
//   PLAY_PACKAGE (com.thecaloriecard.app)
//   PLAY_RTDN_TOKEN: a long random string, also put on the end of the
//     Pub/Sub push address (?token=…), so only Google's messages are
//     accepted.

import { createSign, timingSafeEqual } from "node:crypto";
import axios from "axios";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { entitlementFrom, mirrorPremium, mayReplace } from "./billing.js";

const PACKAGE = process.env.PLAY_PACKAGE || "com.thecaloriecard.app";
const API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

/** Play product id → our plan name (both names are accepted). */
export const PLAY_PRODUCTS = {
  monthly: "monthly",
  yearly: "yearly",
  premium_monthly: "monthly",
  premium_yearly: "yearly",
};

// Same as billing.js: states that still count as paid.
const PAID_STATES = new Set(["active", "trialing", "past_due"]);

let serviceAccount = null;
let enabled = false;

const db = () => getFirestore();
const billingRef = (uid) => db().collection("billing").doc(uid);

// -------------------- Google API access --------------------

const b64url = (v) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v))
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

let cachedToken = null; // { token, expires }

/** An access token for the Play Developer API, from the service account. */
async function accessToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 60_000) return cachedToken.token;
  const now = Math.floor(Date.now() / 1000);
  const unsigned =
    `${b64url({ alg: "RS256", typ: "JWT" })}.` +
    b64url({
      iss: serviceAccount.client_email,
      scope: SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(serviceAccount.private_key, "base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const r = await axios.post(
    "https://oauth2.googleapis.com/token",
    new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }).toString(),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
  cachedToken = {
    token: r.data.access_token,
    expires: Date.now() + (Number(r.data.expires_in) || 3600) * 1000,
  };
  return cachedToken.token;
}

async function playApi(method, path, data) {
  const token = await accessToken();
  const r = await axios({
    method,
    url: `${API}/${encodeURIComponent(PACKAGE)}/${path}`,
    data,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  return r.data;
}

/** The subscription behind [purchaseToken], as Google has it now. */
function fetchSubscription(purchaseToken) {
  return playApi("get", `purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`);
}

function acknowledge(productId, purchaseToken) {
  return playApi(
    "post",
    `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/` +
      `${encodeURIComponent(purchaseToken)}:acknowledge`,
    {}
  );
}

// -------------------- Google's answer → billing/{uid} --------------------

/**
 * What a Google Play subscription (subscriptionsv2 response) means for
 * billing/{uid}: status (as Stripe names them, so entitlementFrom works),
 * plan, the end of the paid period and whether it renews. Exported for
 * tests.
 */
export function playToBilling(sub) {
  const line = (Array.isArray(sub?.lineItems) ? sub.lineItems : [])[0] || {};
  const productId = String(line.productId || "");
  const expiry = line.expiryTime ? new Date(line.expiryTime) : null;
  const state = String(sub?.subscriptionState || "");
  const status =
    {
      SUBSCRIPTION_STATE_ACTIVE: "active",
      // Google is retrying the payment: keep Premium meanwhile.
      SUBSCRIPTION_STATE_IN_GRACE_PERIOD: "past_due",
      // Cancelled, but paid until the end of the period.
      SUBSCRIPTION_STATE_CANCELED: "active",
      SUBSCRIPTION_STATE_ON_HOLD: "on_hold",
      SUBSCRIPTION_STATE_PAUSED: "paused",
      SUBSCRIPTION_STATE_EXPIRED: "expired",
      SUBSCRIPTION_STATE_PENDING: "pending",
      SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: "expired",
    }[state] || "expired";
  const renews = line.autoRenewingPlan?.autoRenewEnabled;
  return {
    status,
    plan: PLAY_PRODUCTS[productId] || null,
    productId,
    periodEnd: expiry && !Number.isNaN(expiry.getTime()) ? expiry : null,
    cancelAtPeriodEnd: state === "SUBSCRIPTION_STATE_CANCELED" || renews === false,
    accountId: sub?.externalAccountIdentifiers?.obfuscatedExternalAccountId || null,
    linkedPurchaseToken: sub?.linkedPurchaseToken || null,
    needsAck: sub?.acknowledgementState === "ACKNOWLEDGEMENT_STATE_PENDING",
  };
}

const isPaid = (status, periodEnd, now = new Date()) =>
  PAID_STATES.has(status) && !!periodEnd && periodEnd.getTime() > now.getTime();

/** Copies a Google Play subscription onto billing/{uid}. */
async function syncPlay(uid, purchaseToken, sub) {
  const p = playToBilling(sub);
  const data = await db().runTransaction(async (tx) => {
    const ref = billingRef(uid);
    const current = (await tx.get(ref)).data() || {};
    if (!mayReplace(current, "play", isPaid(p.status, p.periodEnd))) return current;
    const update = {
      store: "play",
      status: p.status,
      plan: p.plan,
      current_period_end: p.periodEnd ? Timestamp.fromDate(p.periodEnd) : null,
      cancel_at_period_end: p.cancelAtPeriodEnd,
      play_product_id: p.productId || null,
      play_purchase_token: purchaseToken,
      updated_at: FieldValue.serverTimestamp(),
    };
    tx.set(ref, update, { merge: true });
    return { ...current, ...update };
  });
  await mirrorPremium(uid, data);
  if (p.needsAck && p.productId) {
    // Unacknowledged purchases are refunded by Google after 3 days. The app
    // acknowledges too; whichever is first wins.
    try {
      await acknowledge(p.productId, purchaseToken);
    } catch (err) {
      console.warn("[play] acknowledge failed:", err.response?.status || err.message);
    }
  }
  return { data, play: p };
}

/** The account a purchase token belongs to, from what we've stored. */
async function uidForToken(purchaseToken) {
  const snap = await db()
    .collection("billing")
    .where("play_purchase_token", "==", purchaseToken)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

/**
 * Stops a Google Play subscription renewing (account deletion). The rest of
 * the paid period isn't refunded, as with Stripe's cancel-at-period-end.
 */
export async function cancelPlaySubscription(billing) {
  const token = billing?.play_purchase_token;
  const productId = billing?.play_product_id;
  if (!enabled || !token || !productId) return "none";
  try {
    await playApi(
      "post",
      `purchases/subscriptions/${encodeURIComponent(productId)}/tokens/` +
        `${encodeURIComponent(token)}:cancel`,
      {}
    );
    return "cancelled";
  } catch (err) {
    const status = err.response?.status;
    if (status === 404 || status === 410) return "gone";
    throw err;
  }
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

// -------------------- Routes --------------------

export function registerPlayBilling(app, { requireFirebaseUser, firestoreReady, serviceAccount: sa }) {
  serviceAccount = sa || null;
  const own = process.env.PLAY_SERVICE_ACCOUNT;
  if (own) {
    try {
      serviceAccount = JSON.parse(
        own.trim().startsWith("{") ? own : Buffer.from(own, "base64").toString("utf8")
      );
    } catch (err) {
      console.error("PLAY_SERVICE_ACCOUNT isn't valid JSON:", err.message);
    }
  }
  enabled = !!firestoreReady && !!serviceAccount?.client_email && !!serviceAccount?.private_key;
  console.log(`[play] Google Play billing ${enabled ? "on" : "off"} (${PACKAGE})`);

  // The app, straight after a purchase (or "Restore purchases").
  app.post("/billing/play/verify", requireFirebaseUser, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first" });
    if (!enabled) {
      return res.status(503).json({ error: "Payments aren't set up yet. Try again soon." });
    }
    const purchaseToken = String(req.body?.purchaseToken || "").trim();
    if (!purchaseToken || purchaseToken.length > 4096) {
      return res.status(400).json({ error: "Missing purchase" });
    }
    try {
      let sub;
      try {
        sub = await fetchSubscription(purchaseToken);
      } catch (err) {
        const status = err.response?.status;
        console.warn("[play] verify lookup failed:", status || err.message);
        if (status === 400 || status === 404 || status === 410) {
          return res.status(400).json({ error: "Google Play doesn't recognise that purchase." });
        }
        return res.status(502).json({ error: "Couldn't check with Google Play. Try again?" });
      }
      const p = playToBilling(sub);
      if (!p.plan) return res.status(400).json({ error: "That isn't a Premium plan." });
      // Bought by this account (the app sets the account id to the uid).
      if (p.accountId && p.accountId !== uid) {
        return res.status(403).json({ error: "That purchase belongs to another account." });
      }
      const owner = await uidForToken(purchaseToken);
      if (owner && owner !== uid) {
        return res.status(403).json({ error: "That purchase belongs to another account." });
      }
      const { data } = await syncPlay(uid, purchaseToken, sub);
      const e = entitlementFrom(data);
      return res.json({ premium: e.premium, subscribed: e.subscribed, plan: p.plan, status: p.status });
    } catch (err) {
      console.error("[play] verify failed:", err.message);
      return res.status(500).json({ error: "Something went wrong. Try again?" });
    }
  });

  // Google → us (Pub/Sub push). Always answer quickly; a 5xx makes Pub/Sub
  // retry, which is what we want when we couldn't reach Google ourselves.
  app.post("/billing/play/rtdn", async (req, res) => {
    const expected = process.env.PLAY_RTDN_TOKEN;
    if (!expected || !sameSecret(req.query?.token, expected)) {
      return res.status(403).send("Forbidden");
    }
    if (!enabled) return res.status(503).send("Not configured");
    let note;
    try {
      note = JSON.parse(Buffer.from(String(req.body?.message?.data || ""), "base64").toString("utf8"));
    } catch (_) {
      return res.status(204).end(); // not a message we understand: don't retry
    }
    if (note?.packageName && note.packageName !== PACKAGE) return res.status(204).end();
    const purchaseToken = note?.subscriptionNotification?.purchaseToken;
    if (!purchaseToken) return res.status(204).end(); // test or one-time product messages
    try {
      const sub = await fetchSubscription(purchaseToken);
      const p = playToBilling(sub);
      const uid =
        p.accountId ||
        (await uidForToken(purchaseToken)) ||
        (p.linkedPurchaseToken ? await uidForToken(p.linkedPurchaseToken) : null);
      if (!uid) {
        console.warn("[play] notification for a purchase with no account yet");
        return res.status(204).end(); // the app's verify call will catch it
      }
      await syncPlay(uid, purchaseToken, sub);
      return res.status(204).end();
    } catch (err) {
      console.error("[play] notification failed:", err.response?.status || err.message);
      return res.status(500).send("Retry");
    }
  });
}
