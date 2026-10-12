// New message notifications: POST /notify/chat
//
// The app calls this (fire-and-forget) after sending a message. We read
// the conversation ourselves rather than trusting the caller, and send
// each other person a push, but only for the first message they haven't
// read (or if their last one was a while ago), so a burst of messages is
// one notification, not ten. Each chat's notifications replace each other
// on the phone (same tag).
//
// Body: { conversationId }   →   { sent: number }

import rateLimit from "express-rate-limit";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const APP_URL = process.env.APP_URL || "https://thecaloriecard.com/";

/** Another push for the same chat only after this long. */
const QUIET_MS = 15 * 60 * 1000;

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const list = (v) => (Array.isArray(v) ? v : []);

/**
 * Whether `to` should get a push now: they have something unread and
 * either this is the first unread message or the last push was a while
 * ago. Exported for tests.
 */
export function shouldNotify(convo, to, now = Date.now()) {
  const unread = Number(convo?.unread_count?.[to] || 0);
  if (unread <= 0) return false;
  const last = convo?.push_at?.[to];
  const lastMs = last?.toMillis?.() ?? (typeof last === "number" ? last : 0);
  return unread === 1 || now - lastMs >= QUIET_MS;
}

/** The notification text. Exported for tests. */
export function chatMessage(convo, senderName) {
  const name = String(senderName || "A friend").slice(0, 40);
  const raw = String(convo?.last_message || "").replace(/\s+/g, " ").trim();
  const text = raw.length > 100 ? `${raw.slice(0, 97)}…` : raw;
  if (convo?.is_group) {
    const group = String(convo.conversation_name || "Your group").slice(0, 40);
    return { title: `💬 ${group}`, body: text ? `${name}: ${text}` : `${name} sent a message` };
  }
  return { title: `💬 ${name}`, body: text || "Sent you a message" };
}

function displayName(user) {
  const chosen = String(user?.display_name || "").trim();
  if (chosen) return chosen;
  const email = String(user?.email || "");
  const at = email.indexOf("@");
  return at > 0 ? email.slice(0, at) : "A friend";
}

async function sendPush(db, toUid, conversationId, msg) {
  const userRef = db.collection("users").doc(toUid);
  const user = (await userRef.get()).data() || {};
  if (user.chat_notifications === false) return 0;
  const tokens = [...new Set(list(user.fcm_tokens).filter((t) => typeof t === "string" && t))];
  if (!tokens.length) return 0;

  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    webpush: {
      notification: {
        title: msg.title,
        body: msg.body,
        icon: new URL("icons/Icon-192.png", APP_URL).toString(),
        tag: `chat-${conversationId}`,
      },
      fcmOptions: { link: APP_URL },
    },
    android: { notification: { tag: `chat-${conversationId}` } },
    data: { conversation_id: conversationId },
  });
  const dead = res.responses
    .map((r, i) => (!r.success && DEAD_TOKEN_CODES.has(r.error?.code) ? tokens[i] : null))
    .filter(Boolean);
  if (dead.length) {
    await userRef.update({ fcm_tokens: FieldValue.arrayRemove(...dead) }).catch(() => {});
  }
  return res.successCount;
}

export function registerChat(app, { requireFirebaseUser, firestoreReady }) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 40,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`),
    message: { error: "Slow down a little." },
  });

  app.post("/notify/chat", requireFirebaseUser, limiter, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first." });
    if (!firestoreReady) return res.json({ sent: 0 });

    const conversationId = String(req.body?.conversationId || "");
    if (!/^[A-Za-z0-9_-]{1,140}$/.test(conversationId)) {
      return res.status(400).json({ error: "Which chat?" });
    }

    try {
      const db = getFirestore();
      const ref = db.collection("conversations").doc(conversationId);

      // Decide and claim in one transaction, so two calls at once can't
      // both send.
      const plan = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const convo = snap.data();
        const people = list(convo.participant_ids);
        if (!people.includes(uid)) return { forbidden: true };
        if (convo.last_sender_id && convo.last_sender_id !== uid) return null;
        const now = Date.now();
        const to = people.filter((p) => p !== uid && shouldNotify(convo, p, now));
        if (!to.length) return null;
        const stamp = Timestamp.fromMillis(now);
        tx.update(ref, Object.fromEntries(to.map((p) => [`push_at.${p}`, stamp])));
        return { to, convo };
      });

      if (plan?.forbidden) return res.status(403).json({ error: "Not your chat." });
      if (!plan) return res.json({ sent: 0 });

      const sender = (await db.collection("users").doc(uid).get()).data();
      const msg = chatMessage(plan.convo, displayName(sender));
      let sent = 0;
      for (const to of plan.to) {
        sent += await sendPush(db, to, conversationId, msg).catch(() => 0);
      }
      return res.json({ sent });
    } catch (err) {
      console.error("[notify/chat]", err.message || err);
      // Notifications are a nice extra: never fail the app's action.
      return res.json({ sent: 0 });
    }
  });
}
