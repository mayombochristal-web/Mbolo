/**
 * Mbolo V20.1 — Validation serveur des transferts + push inbox
 * Exécution : Cloud Function scheduled OU cron externe (toutes les 1-2 min).
 *
 * Sécurité : SDK Admin → bypass total des règles client.
 * Idempotence : claim transactionnel sur `s = 'p' → 'work'`.
 *
 * ⚠️ Limites connues (documentées, non corrigées ici) :
 *  - pushInbox() scanne toute la base `inbox/` → à optimiser via queue dédiée
 *    quand le nombre d'users dépasse ~5 000.
 *  - Aucun verrou distribué entre deux instances parallèles (une seule instance
 *    recommandée via maxInstances=1 sur Cloud Functions).
 */

const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://mbolo-81868-default-rtdb.firebaseio.com"
});

const db = admin.database();
const ADMIN_UID = 'urGWEwETbaMavqbu7jwa6fToUXz2';
const FEE_TR = 0.03, FEE_WD = 0.03;
const INBOX_SCAN_LIMIT = 2000; // au-delà : log d'alerte + ignoré ce cycle
const kc = d => (d / 10).toFixed(1) + " KC";

// ---------- Envoi push FCM ----------
async function sendPush(uid, token, title, body) {
  try {
    await admin.messaging().send({
      token,
      data: { title, body, tag: 'mbolo' }, // ← aligné sur le SW (payload data only)
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    });
    return true;
  } catch (e) {
    console.error(`[push] ${uid} ${e.code || e.message}`);
    if (e.code === 'messaging/registration-token-not-registered' ||
        e.code === 'messaging/invalid-registration-token') {
      await db.ref(`users/${uid}/fcmToken`).remove().catch(() => {});
    }
    return false;
  }
}

// ---------- Traitement des transferts ----------
async function processTransfers() {
  // Correctif 1 : respecter le gel global
  const freeze = (await db.ref('config/freeze').once('value')).val();
  if (freeze === true) {
    console.log("⏸️ Opérations gelées (config/freeze=true) → cycle ignoré.");
    return;
  }

  const snap = await db.ref('transfer_requests').orderByChild('s').equalTo('p').once('value');
  if (!snap.exists()) { console.log("Aucune demande en attente."); return; }

  for (const [key, r] of Object.entries(snap.val())) {
    try {
      // Correctif 2 : vérifier suspension du demandeur
      const susp = (await db.ref(`suspended/${r.f}`).once('value')).val();
      if (susp) {
        console.log(`🚫 Demandeur ${r.fn} suspendu → demande ${key} refusée.`);
        await db.ref(`transfer_requests/${key}/s`).set('no');
        continue;
      }

      // Claim atomique : p → work (empêche double validation)
      const claim = await db.ref(`transfer_requests/${key}/s`)
        .transaction(cur => cur === 'p' ? 'work' : undefined);
      if (!claim.committed) { console.log(`${key} déjà traitée.`); continue; }

      const fee = Math.round(r.a * (r.t === 'wd' ? FEE_WD : FEE_TR));
      let toId = null;

      if (r.t === 'tr') {
        toId = (await db.ref(`ids/${r.to}`).once('value')).val();
        if (!toId) {
          console.log(`Destinataire ${r.to} inconnu → refusé.`);
          await db.ref(`transfer_requests/${key}/s`).set('no');
          continue;
        }
        // Refuser un transfert vers soi-même
        if (toId === r.f) {
          console.log(`Auto-transfert ${key} → refusé.`);
          await db.ref(`transfer_requests/${key}/s`).set('no');
          continue;
        }
      }

      // Débit atomique du demandeur
      const debit = await db.ref(`users/${r.f}/bal`)
        .transaction(cur => (cur || 0) >= r.a ? (cur || 0) - r.a : undefined);
      if (!debit.committed) {
        console.log(`Solde insuffisant pour ${r.fn} → refusé.`);
        await db.ref(`transfer_requests/${key}/s`).set('no');
        continue;
      }

      // Crédit du destinataire (hors frais) et frais admin
      if (toId) await db.ref(`users/${toId}/bal`)
        .transaction(cur => (cur || 0) + r.a - fee);
      await db.ref(`users/${ADMIN_UID}/bal`)
        .transaction(cur => (cur || 0) + fee);

      // Écritures groupées : historiques + inbox + log + statut final
      const now = Date.now(), U = {};
      const nid = p => db.ref(p).push().key;

      U[`users/${r.f}/hist/${nid('h')}`] = {
        t: r.t, txt: r.t === 'wd' ? "Retrait demandé" : "Envoi vers " + (r.to || ""),
        a: -r.a, ts: now
      };
      U[`inbox/${r.f}/${nid('n')}`] = {
        txt: r.t === 'wd' ? `💸 Ton retrait de ${kc(r.a)} est validé.` : `🔁 Ton envoi de ${kc(r.a)} est validé.`,
        ts: now
      };
      if (toId) {
        U[`users/${toId}/hist/${nid('h')}`] = { t: 'tr', txt: "Reçu de " + r.fn, a: r.a - fee, ts: now };
        U[`inbox/${toId}/${nid('n')}`] = { txt: `🎉 Tu as reçu ${kc(r.a - fee)} de ${r.fn}`, ts: now };
      }
      U[`log/${nid('log')}`] = {
        by: 'robot', t: r.t, f: r.fn, to: r.to || "", a: r.a, fee, ts: now
      };
      U[`transfer_requests/${key}/s`] = 'ok';

      await db.ref().update(U);
      console.log(`✅ ${key} validée (${r.t}, ${kc(r.a)}).`);
    } catch (e) {
      console.error(`Erreur sur ${key}:`, e);
      // Rollback du claim 'work' → 'p' pour nouvelle tentative au prochain cycle
      await db.ref(`transfer_requests/${key}/s`)
        .transaction(cur => cur === 'work' ? 'p' : undefined).catch(() => {});
    }
  }
}

// ---------- Push des nouvelles inbox ----------
async function pushInbox() {
  // Correctif 3 : avertir si trop volumineux, sinon on risquerait un timeout
  const snap = await db.ref('inbox').once('value');
  if (!snap.exists()) return;

  const entries = Object.entries(snap.val());
  if (entries.length > INBOX_SCAN_LIMIT) {
    console.warn(`⚠️ inbox contient ${entries.length} users (limite ${INBOX_SCAN_LIMIT}). ` +
                 `Seuls ${INBOX_SCAN_LIMIT} seront scannés ce cycle. ` +
                 `Envisager une queue dédiée ou une pagination.`);
  }

  let sent = 0, scanned = 0;
  for (const [uid, items] of entries.slice(0, INBOX_SCAN_LIMIT)) {
    const fresh = Object.entries(items).filter(([, n]) => !n.pushed && n.txt);
    if (!fresh.length) continue;
    scanned++;

    const token = (await db.ref(`users/${uid}/fcmToken`).once('value')).val();
    for (const [nk, n] of fresh) {
      if (token) {
        const ok = await sendPush(uid, token, "Mbolo 🥁", n.txt);
        if (ok) sent++;
      }
      // Marquer comme poussé même sans token (évite de re-scanner)
      await db.ref(`inbox/${uid}/${nk}/pushed`).set(true).catch(() => {});
    }
  }
  console.log(`🔔 ${sent} push envoyée(s) sur ${scanned} user(s) actif(s).`);
}

// ---------- Point d'entrée ----------
(async () => {
  await processTransfers();
  await pushInbox();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });