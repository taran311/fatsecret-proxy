// Guess the Calories "your turn" notifications: POST /notify/game
//
// The app calls this (fire-and-forget) after creating a game, picking
// foods, finishing a set of guesses, or tapping Nudge. We read the game
// ourselves rather than trusting the caller, work out whether the OTHER
// player now has something to do, and send them at most one push for
// each step of the game. `push_sent.{uid}` on the game remembers which
// steps have been sent, so retries and double taps never double up.
//
// Body: { gameId, event: 'update' | 'nudge' }   →   { sent: boolean }

import rateLimit from "express-rate-limit";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const APP_URL = process.env.APP_URL || "https://thecaloriecard.com/";

const DEAD_TOKEN_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
  "messaging/invalid-argument",
]);

const list = (v) => (Array.isArray(v) ? v : []);

/** The foods `uid` has to guess (theirs to guess, not theirs to pick). */
function foodsFor(game, uid) {
  if (game.mode !== "swap") return list(game.foods);
  const other = list(game.player_ids).find((p) => p !== uid);
  return list(game.picks?.[other]);
}

function hasPicked(game, uid) {
  return game.mode !== "swap" || Array.isArray(game.picks?.[uid]);
}

function guessed(game, uid) {
  return list(game.guesses?.[uid]).length;
}

function done(game, uid) {
  const total = foodsFor(game, uid).length;
  return total > 0 && guessed(game, uid) >= total;
}

function isStale(game, now) {
  const ends =
    game.expires_at?.toDate?.() ||
    (game.updated_at?.toDate?.()
      ? new Date(game.updated_at.toDate().getTime() + 7 * 864e5)
      : null);
  return !!ends && now > ends;
}

/**
 * What (if anything) to tell `to` about `game`, after `from` acted.
 * Returns { key, title, body } or null. Exported for tests.
 */
export function messageFor(game, from, to, event, now = new Date()) {
  const name = String(game.names?.[from] || "Your friend").slice(0, 40);
  const finished = game.status === "finished";

  if (finished) {
    if (game.expired) return null;
    return {
      key: "finished",
      title: "🏆 Guess the Calories: results are in",
      body: `${name} has finished. See who won!`,
    };
  }
  if (isStale(game, now)) return null;

  const theirMove = !hasPicked(game, to) || (hasPicked(game, from) && !done(game, to));
  if (!theirMove) return null;

  if (event === "nudge") {
    return {
      key: `nudge-${now.toISOString().slice(0, 10)}`,
      title: "🎯 Your turn in Guess the Calories",
      body: `${name} is waiting for you.`,
    };
  }

  if (!hasPicked(game, to)) {
    return {
      key: "challenge",
      title: `🍽️ ${name} challenged you`,
      body: "Guess what I ate: pick 5 foods you've eaten, then guess theirs.",
    };
  }
  if (game.mode === "swap" && guessed(game, to) === 0 && !done(game, from) && guessed(game, from) === 0) {
    // Both have picked and nobody has guessed yet: the other player picked.
    return {
      key: "ready",
      title: `${name} picked their foods`,
      body: "Your turn: guess what they ate.",
    };
  }
  if (game.mode !== "swap" && guessed(game, from) === 0 && guessed(game, to) === 0) {
    return {
      key: "challenge",
      title: `🎯 ${name} challenged you`,
      body: "Guess the Calories: 5 mystery foods. Closest guesses win.",
    };
  }
  if (done(game, from)) {
    return {
      key: "your-turn",
      title: "🎯 Your turn in Guess the Calories",
      body: `${name} has made their guesses. Your turn!`,
    };
  }
  return null;
}

async function sendPush(db, toUid, gameId, msg) {
  const userRef = db.collection("users").doc(toUid);
  const user = (await userRef.get()).data() || {};
  if (user.game_notifications === false) return 0;
  const tokens = [...new Set(list(user.fcm_tokens).filter((t) => typeof t === "string" && t))];
  if (!tokens.length) return 0;

  const link = new URL(`?game=${encodeURIComponent(gameId)}`, APP_URL).toString();
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    webpush: {
      notification: {
        title: msg.title,
        body: msg.body,
        icon: new URL("icons/Icon-192.png", APP_URL).toString(),
        tag: `game-${gameId}`,
      },
      fcmOptions: { link },
    },
    android: { notification: { tag: `game-${gameId}` } },
    data: { game_id: gameId },
  });
  const dead = res.responses
    .map((r, i) => (!r.success && DEAD_TOKEN_CODES.has(r.error?.code) ? tokens[i] : null))
    .filter(Boolean);
  if (dead.length) {
    await userRef.update({ fcm_tokens: FieldValue.arrayRemove(...dead) }).catch(() => {});
  }
  return res.successCount;
}

export function registerGames(app, { requireFirebaseUser, firestoreReady }) {
  const limiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => (req.user?.uid ? `uid:${req.user.uid}` : `ip:${req.ip}`),
    message: { error: "Slow down a little." },
  });

  app.post("/notify/game", requireFirebaseUser, limiter, async (req, res) => {
    const uid = req.user?.uid;
    if (!uid) return res.status(401).json({ error: "Sign in first." });
    if (!firestoreReady) return res.json({ sent: false });

    const gameId = String(req.body?.gameId || "");
    const event = req.body?.event === "nudge" ? "nudge" : "update";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(gameId)) {
      return res.status(400).json({ error: "Which game?" });
    }

    try {
      const db = getFirestore();
      const ref = db.collection("calorie_games").doc(gameId);

      // Decide and claim the step in one transaction, so two calls at once
      // can't both send.
      const plan = await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return null;
        const game = snap.data();
        const players = list(game.player_ids);
        if (!players.includes(uid)) return { forbidden: true };
        const to = players.find((p) => p !== uid);
        if (!to) return null;
        const msg = messageFor(game, uid, to, event);
        if (!msg) return null;
        if (list(game.push_sent?.[to]).includes(msg.key)) return null;
        tx.update(ref, { [`push_sent.${to}`]: FieldValue.arrayUnion(msg.key) });
        return { to, msg };
      });

      if (plan?.forbidden) return res.status(403).json({ error: "Not your game." });
      if (!plan) return res.json({ sent: false });

      const count = await sendPush(db, plan.to, gameId, plan.msg);
      return res.json({ sent: count > 0 });
    } catch (err) {
      console.error("[notify/game]", err.message || err);
      // Notifications are a nice extra: never fail the app's action.
      return res.json({ sent: false });
    }
  });
}
