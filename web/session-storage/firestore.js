import { db } from "../firebase.js";

const SESSIONS_COLLECTION = "sessions";

/**
 * Firestore-based session storage for Shopify.
 * Implements the SessionStorage interface from @shopify/shopify-app-session-storage.
 */
export class FirestoreSessionStorage {
  async storeSession(session) {
    const _start = Date.now();
    console.log("[firestore:storeSession] >>> ENTRY — sessionId=%s shop=%s isOnline=%s", session.id, session.shop, session.isOnline);

    const docRef = db.collection(SESSIONS_COLLECTION).doc(session.id);
    await docRef.set({
      id: session.id,
      shop: session.shop,
      state: session.state,
      isOnline: session.isOnline,
      scope: session.scope,
      accessToken: session.accessToken,
      expires: session.expires ? session.expires.toISOString() : null,
      onlineAccessInfo: session.onlineAccessInfo || null,
    });

    console.log("[firestore:storeSession] <<< EXIT SUCCESS — sessionId=%s stored for shop=%s (%dms)", session.id, session.shop, Date.now() - _start);
    return true;
  }

  async loadSession(id) {
    const _start = Date.now();
    console.log("[firestore:loadSession] >>> ENTRY — sessionId=%s", id);

    const doc = await db.collection(SESSIONS_COLLECTION).doc(id).get();
    if (!doc.exists) {
      console.log("[firestore:loadSession] <<< EXIT — session NOT FOUND — sessionId=%s (%dms)", id, Date.now() - _start);
      return undefined;
    }

    const data = doc.data();
    console.log("[firestore:loadSession] <<< EXIT SUCCESS — sessionId=%s shop=%s isOnline=%s expires=%s (%dms)", data.id, data.shop, data.isOnline, data.expires || "never", Date.now() - _start);

    return {
      id: data.id,
      shop: data.shop,
      state: data.state,
      isOnline: data.isOnline,
      scope: data.scope,
      accessToken: data.accessToken,
      expires: data.expires ? new Date(data.expires) : undefined,
      onlineAccessInfo: data.onlineAccessInfo || undefined,
    };
  }

  async deleteSession(id) {
    const _start = Date.now();
    console.log("[firestore:deleteSession] >>> ENTRY — sessionId=%s", id);

    await db.collection(SESSIONS_COLLECTION).doc(id).delete();

    console.log("[firestore:deleteSession] <<< EXIT SUCCESS — sessionId=%s deleted (%dms)", id, Date.now() - _start);
    return true;
  }

  async deleteSessions(ids) {
    const _start = Date.now();
    console.log("[firestore:deleteSessions] >>> ENTRY — count=%d sessionIds=%s", ids.length, JSON.stringify(ids));

    const batch = db.batch();
    for (const id of ids) {
      batch.delete(db.collection(SESSIONS_COLLECTION).doc(id));
    }
    await batch.commit();

    console.log("[firestore:deleteSessions] <<< EXIT SUCCESS — %d sessions deleted (%dms)", ids.length, Date.now() - _start);
    return true;
  }

  async findSessionsByShop(shop) {
    const _start = Date.now();
    console.log("[firestore:findSessionsByShop] >>> ENTRY — shop=%s", shop);

    const snapshot = await db
      .collection(SESSIONS_COLLECTION)
      .where("shop", "==", shop)
      .get();

    const sessions = snapshot.docs.map((doc) => {
      const data = doc.data();
      return {
        id: data.id,
        shop: data.shop,
        state: data.state,
        isOnline: data.isOnline,
        scope: data.scope,
        accessToken: data.accessToken,
        expires: data.expires ? new Date(data.expires) : undefined,
        onlineAccessInfo: data.onlineAccessInfo || undefined,
      };
    });

    console.log("[firestore:findSessionsByShop] <<< EXIT SUCCESS — shop=%s sessionsFound=%d (%dms)", shop, sessions.length, Date.now() - _start);
    return sessions;
  }
}
