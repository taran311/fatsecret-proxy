// Premium: Stripe subscriptions, the 30-day free trial and what free
// accounts can use.
//
// Data (written only by this server; the app just reads it):
//   billing/{uid}  trial_started_at, trial_ends_at, status, plan,
//                  current_period_end, cancel_at_period_end, founder,
//                  stripe_customer_id, stripe_subscription_id,
//                  coach_day, coach_count, trial_notice_sent
//   users/{uid}.premium_until   mirror used to show the Premium card design
//                               (to you and to friends looking at your card)
//   meta/billing.founders       how many early-supporter places are taken
//
// Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_MONTHLY,
// STRIPE_PRICE_YEARLY, STRIPE_PRICE_FOUNDER, and optionally FOUNDER_LIMIT
// (300), TRIAL_DAYS (30), FREE_COACH_PER_DAY (5), APP_URL.
//
// Without a Firebase service account nothing can be checked, so everyone is
// treated as Premium (the app keeps working exactly as before).

import express from "express";
import Stripe from "stripe";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const APP_URL = process.env.APP_URL || "https://thecaloriecard.com/";
const TRIAL_DAYS = Number(process.env.TRIAL_DAYS) || 30;
const FREE_COACH_PER_DAY = Number(process.env.FREE_COACH_PER_DAY) || 5;
const FOUNDER_LIMIT = Number(process.env.FOUNDER_LIMIT) || 300;
const DAY_MS = 24 * 3600 * 1000;

const PRICES = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  yearly: process.env.STRIPE_PRICE_YEARLY,
  founder: process.env.STRIPE_PRICE_FOUNDER,
};

// Subscription states that still count as paid (past_due: Stripe is
// retrying the card, so don't take Premium away yet).
const PAID_STATES = new Set(["active", "trialing", "past_due"]);

let enabled = false; // Firestore reachable (service account present)
let stripe = null;

const db = () => getFirestore();
const billingRef = (uid) => db().collection("billing").doc(uid);
const userRef = (uid) => db().collection("users").doc(uid);

const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v === "number") return new Date(v);
  return null;
};

/** Today's date in the UK, e.g. "2026-10-10" (free Coach messages reset). */
export function ukDayKey(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Works out what someone has from their billing document. */
export function entitlementFrom(data, now = new Date()) {
  const d = data || {};
  const periodEnd = toDate(d.current_period_end);
  const trialEnd = toDate(d.trial_ends_at);
  const subscribed =
    PAID_STATES.has(d.status) && !!periodEnd && periodEnd.getTime() > now.getTime();
  const inTrial = !subscribed && !!trialEnd && trialEnd.getTime() > now.getTime();
  return { premium: subscribed || inTrial, subscribed, inTrial, trialEnd, periodEnd };
}

/** The date Premium lasts until (for the card design mirror). */
function premiumUntil(data, now = new Date()) {
  const e = entitlementFrom(data, now);
  const dates = [];
  if (e.subscribed && e.periodEnd) dates.push(e.periodEnd.getTime());
  if (e.trialEnd) dates.push(e.trialEnd.getTime());
  return dates.length ? new Date(Math.max(...dates)) : now;
}

async function mirrorPremium(uid, data) {
  await userRef(uid).set(
    { premium_until: Timestamp.fromDate(premiumUntil(data)) },
    { merge: true }
  );
}

export async function isPremium(uid) {
  if (!enabled || !uid) return true;
  try {
    const snap = await billingRef(uid).get();
    return entitlementFrom(snap.data()).premium;
  } catch (err) {
    console.error("[billing] entitlement check failed:", err.message);
    return true; // don't punish people for our outage
  }
}

/**
 * Called before each Coach message. Premium: always allowed. Free: up to
 * FREE_COACH_PER_DAY a day. Returns { allowed, premium, freeLeft }.
 */
export async function useCoachMessage(uid) {
  if (!enabled || !uid) return { allowed: true, premium: true, freeLeft: null };
  const ref = billingRef(uid);
  const day = ukDayKey();
  try {
    return await db().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.data() || {};
      if (entitlementFrom(data).premium) {
        return { allowed: true, premium: true, freeLeft: null };
      }
      const used = data.coach_day === day ? Number(data.coach_count) || 0 : 0;
      if (used >= FREE_COACH_PER_DAY) {
        return { allowed: false, premium: false, freeLeft: 0 };
      }
      tx.set(ref, { coach_day: day, coach_count: used + 1 }, { merge: true });
      return { allowed: true, premium: false, freeLeft: FREE_COACH_PER_DAY - used - 1 };
    });
  } catch (err) {
    console.error("[billing] coach count failed:", err.message);
    return { allowed: true, premium: true, freeLeft: null };
  }
}

/** Gives back a free message when the Coach couldn't answer. */
export async function refundCoachMessage(uid) {
  if (!enabled || !uid) return;
  const ref = billingRef(uid);
  const day = ukDayKey();
  try {
    await db().runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() || {};
      const used = Number(data.coach_count) || 0;
      if (data.coach_day === day && used > 0) {
        tx.set(ref, { coach_count: used - 1 }, { merge: true });
      }
    });
  } catch (_) {}
}

function planForPrice(priceId) {
  if (!priceId) return null;
  for (const [plan, id] of Object.entries(PRICES)) if (id && id === priceId) return plan;
  return null;
}

function periodEndOf(sub) {
  const s = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
  return s ? new Date(s * 1000) : null;
}

async function uidForCustomer(customerId) {
  const snap = await db()
    .collection("billing")
    .where("stripe_customer_id", "==", customerId)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

/** Copies a Stripe subscription onto billing/{uid}. */
async function syncSubscription(sub, uidHint) {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const uid = uidHint || sub.metadata?.uid || (customerId && (await uidForCustomer(customerId)));
  if (!uid) {
    console.warn("[billing] subscription with no user:", sub.id);
    return;
  }
  const priceId = sub.items?.data?.[0]?.price?.id;
  const plan = planForPrice(priceId) || sub.metadata?.plan || null;
  const periodEnd = periodEndOf(sub);
  const ref = billingRef(uid);
  const metaRef = db().collection("meta").doc("billing");

  const data = await db().runTransaction(async (tx) => {
    const current = (await tx.get(ref)).data() || {};
    // Keep the newest subscription's details if there are several.
    if (
      current.stripe_subscription_id &&
      current.stripe_subscription_id !== sub.id &&
      PAID_STATES.has(current.status) &&
      !PAID_STATES.has(sub.status)
    ) {
      return current;
    }
    const founderNow = plan === "founder" && PAID_STATES.has(sub.status);
    let metaSnap = null;
    if (founderNow && !current.founder) metaSnap = await tx.get(metaRef);
    const update = {
      status: sub.status,
      plan,
      current_period_end: periodEnd ? Timestamp.fromDate(periodEnd) : null,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      stripe_customer_id: customerId || current.stripe_customer_id || null,
      stripe_subscription_id: sub.id,
      updated_at: FieldValue.serverTimestamp(),
    };
    if (founderNow && !current.founder) {
      update.founder = true;
      const taken = Number(metaSnap?.data()?.founders) || 0;
      tx.set(metaRef, { founders: taken + 1 }, { merge: true });
    }
    tx.set(ref, update, { merge: true });
    return { ...current, ...update, current_period_end: periodEnd };
  });
  await mirrorPremium(uid, data);
}

async function foundersLeft() {
  if (!enabled) return 0;
  const snap = await db().collection("meta").doc("billing").get();
  return Math.max(0, FOUNDER_LIMIT - (Number(snap.data()?.founders) || 0));
}

// -------------------- Trial reminder push --------------------

async function sendTrialNotices(now = new Date()) {
  const from = new Date(now.getTime() + 2 * DAY_MS);
  const to = new Date(now.getTime() + 3 * DAY_MS);
  const snap = await db()
    .collection("billing")
    .where("trial_ends_at", ">=", from)
    .where("trial_ends_at", "<=", to)
    .get();
  for (const doc of snap.docs) {
    try {
      const data = doc.data();
      if (data.trial_notice_sent || entitlementFrom(data, now).subscribed) continue;
      await doc.ref.set({ trial_notice_sent: true }, { merge: true });
      const user = (await userRef(doc.id).get()).data() || {};
      const tokens = Array.isArray(user.fcm_tokens)
        ? user.fcm_tokens.filter((t) => typeof t === "string" && t)
        : [];
      if (!tokens.length) continue; // they'll see it in the app instead
      const title = "Your Premium trial ends soon";
      const body =
        "Logging, streaks and friends stay free. Keep the Coach and more from £2.50 a month.";
      await getMessaging().sendEachForMulticast({
        tokens,
        notification: { title, body },
        webpush: {
          notification: {
            title,
            body,
            icon: new URL("icons/Icon-192.png", APP_URL).toString(),
            tag: "trial-ending",
          },
          fcmOptions: { link: new URL("?premium=plans", APP_URL).toString() },
        },
      });
    } catch (err) {
      console.error("[billing] trial notice failed:", err.message);
    }
  }
}

// -------------------- Routes --------------------

/**
 * Adds the /billing routes. Call BEFORE the JSON body parser runs for
 * /billing/webhook (Stripe signs the raw body).
 */
export function registerBilling(app, { requireFirebaseUser, firestoreReady }) {
  enabled = !!firestoreReady;
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  console.log(
    `[billing] ${enabled ? "on" : "off (no service account: everyone is Premium)"}, ` +
      `Stripe ${stripe ? "configured" : "not configured"}`
  );

  // Stripe → us. Raw body for the signature check.
  app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || !enabled) {
      return res.status(503).send("Billing not configured");
    }
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.get("stripe-signature"),
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.warn("[billing] bad webhook signature:", err.message);
      return res.status(400).send("Bad signature");
    }
    try {
      const obj = event.data.object;
      switch (event.type) {
        case "checkout.session.completed": {
          if (obj.mode === "subscription" && obj.subscription) {
            const uid = obj.client_reference_id || obj.metadata?.uid;
            if (uid && obj.customer) {
              await billingRef(uid).set({ stripe_customer_id: obj.customer }, { merge: true });
            }
            const sub = await stripe.subscriptions.retrieve(obj.subscription);
            await syncSubscription(sub, uid);
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted": {
          // Events can arrive out of order: use the subscription as it is now.
          let sub = obj;
          try {
            sub = await stripe.subscriptions.retrieve(obj.id);
          } catch (_) {}
          await syncSubscription(sub);
          break;
        }
        case "invoice.paid":
        case "invoice.payment_succeeded": {
          const subId =
            obj.subscription || obj.parent?.subscription_details?.subscription || null;
          if (subId) await syncSubscription(await stripe.subscriptions.retrieve(subId));
          break;
        }
        default:
          break;
      }
      return res.json({ received: true });
    } catch (err) {
      console.error("[billing] webhook failed:", err.message);
      return res.status(500).send("Webhook failed"); // Stripe retries
    }
  });

  // Starts the 30-day trial the first time someone opens the app (new and
  // existing users alike). Safe to call every launch.
  app.post("/billing/start-trial", requireFirebaseUser, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first" });
    if (!enabled) return res.json({ premium: true });
    try {
      const data = await db().runTransaction(async (tx) => {
        const ref = billingRef(uid);
        const current = (await tx.get(ref)).data() || {};
        if (current.trial_ends_at) return current;
        const now = new Date();
        const update = {
          trial_started_at: Timestamp.fromDate(now),
          trial_ends_at: Timestamp.fromDate(new Date(now.getTime() + TRIAL_DAYS * DAY_MS)),
        };
        tx.set(ref, update, { merge: true });
        return { ...current, ...update };
      });
      await mirrorPremium(uid, data);
      const e = entitlementFrom(data);
      return res.json({ premium: e.premium, trialEndsAt: e.trialEnd?.toISOString() || null });
    } catch (err) {
      console.error("[billing] start trial failed:", err.message);
      return res.status(500).json({ error: "Couldn't start your trial" });
    }
  });

  // Early-supporter places left.
  app.get("/billing/offer", requireFirebaseUser, async (req, res) => {
    try {
      const left = PRICES.founder ? await foundersLeft() : 0;
      return res.json({ founderLeft: left, freeCoachPerDay: FREE_COACH_PER_DAY });
    } catch (err) {
      return res.json({ founderLeft: 0, freeCoachPerDay: FREE_COACH_PER_DAY });
    }
  });

  // Sends you to Stripe's payment page.
  app.post("/billing/checkout", requireFirebaseUser, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first" });
    if (!stripe || !enabled) {
      return res.status(503).json({ error: "Payments aren't set up yet. Try again soon." });
    }
    let plan = String(req.body?.plan || "yearly");
    if (!["monthly", "yearly", "founder"].includes(plan)) plan = "yearly";
    try {
      if (plan === "founder" && (!PRICES.founder || (await foundersLeft()) <= 0)) {
        plan = "yearly";
      }
      const price = PRICES[plan];
      if (!price) return res.status(503).json({ error: "That plan isn't available yet." });

      const billing = (await billingRef(uid).get()).data() || {};
      if (entitlementFrom(billing).subscribed) {
        return res.status(409).json({ error: "You're already subscribed." });
      }
      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price, quantity: 1 }],
        client_reference_id: uid,
        metadata: { uid, plan },
        subscription_data: { metadata: { uid, plan } },
        ...(billing.stripe_customer_id
          ? { customer: billing.stripe_customer_id }
          : req.user?.email
            ? { customer_email: req.user.email }
            : {}),
        allow_promotion_codes: true,
        success_url: new URL("?premium=success", APP_URL).toString(),
        cancel_url: new URL("?premium=cancelled", APP_URL).toString(),
      });
      return res.json({ url: session.url });
    } catch (err) {
      console.error("[billing] checkout failed:", err.message);
      return res.status(502).json({ error: "Couldn't open the payment page. Try again?" });
    }
  });

  // Stripe's own page to change plan, update card or cancel.
  app.post("/billing/portal", requireFirebaseUser, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first" });
    if (!stripe || !enabled) {
      return res.status(503).json({ error: "Payments aren't set up yet." });
    }
    try {
      const billing = (await billingRef(uid).get()).data() || {};
      if (!billing.stripe_customer_id) {
        return res.status(404).json({ error: "No subscription to manage yet." });
      }
      const session = await stripe.billingPortal.sessions.create({
        customer: billing.stripe_customer_id,
        return_url: APP_URL,
      });
      return res.json({ url: session.url });
    } catch (err) {
      console.error("[billing] portal failed:", err.message);
      return res.status(502).json({ error: "Couldn't open your subscription. Try again?" });
    }
  });

  if (enabled) {
    const run = () =>
      sendTrialNotices().catch((err) =>
        console.error("[billing] trial notices failed:", err.message)
      );
    setTimeout(run, 60 * 1000);
    setInterval(run, 60 * 60 * 1000);
  }
}
