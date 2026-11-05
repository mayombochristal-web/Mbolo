const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://mbolo-81868-default-rtdb.firebaseio.com"
});

const db = admin.database();
const ADMIN_UID = 'urGWEwETbaMavqbu7jwa6fToUXz2'; // Votre UID
const FEE_TR = 0.03, FEE_WD = 0.03; 
const kc = d => (d / 10).toFixed(1) + " KC";

// Notifications
async function sendPush(uid, token, title, body) {
  try {
    await admin.messaging().send({
      token,
      data: { title, body },
      webpush: { headers: { Urgency: 'high', TTL: '86400' } }
    });
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered') {
      await db.ref(`users/${uid}/fcmToken`).remove().catch(() => {});
    }
  }
}

// Traitement principal
async function processRequests() {
  const snap = await db.ref('transfer_requests').orderByChild('s').equalTo('p').once('value');
  if (!snap.exists()) return;

  for (const [key, r] of Object.entries(snap.val())) {
    try {
      // 1. Verrouiller la demande pour éviter les doubles traitements
      const claim = await db.ref(`transfer_requests/${key}/s`).transaction(cur => cur === 'p' ? 'work' : undefined);
      if (!claim.committed) continue; // Déjà traitée par un autre processus

      const fee = Math.round(r.a * (r.t === 'wd' ? FEE_WD : FEE_TR));
      const now = Date.now();
      const U = {};
      const nid = p => db.ref(p).push().key;

      // 2. Vérifier le solde de l'expéditeur
      const senderBal = (await db.ref(`users/${r.f}/bal`).once('value')).val() || 0;
      if (senderBal < r.a) {
        U[`transfer_requests/${key}/s`] = 'no';
        await db.ref().update(U);
        continue;
      }

      // 3. Traitement selon le type
      if (r.t === 'sub') {
        // C'est un abonnement à un tunnel
        const tid = r.m.replace('Abonnement ', '').trim(); // ex: CLS-ABCD
        
        // Débiter l'élève
        U[`users/${r.f}/bal`] = senderBal - r.a;
        U[`users/${r.f}/hist/${nid('h')}`] = { t: 'sub', txt: `Abonnement ${tid}`, a: -r.a, ts: now };
        
        // Créditer le propriétaire du tunnel
        const ownerUid = (await db.ref(`tunnels/${tid}/meta/owner`).once('value')).val();
        if (ownerUid) {
          const ownerBal = (await db.ref(`users/${ownerUid}/bal`).once('value')).val() || 0;
          U[`users/${ownerUid}/bal`] = ownerBal + (r.a - fee);
          U[`users/${ownerUid}/hist/${nid('h')}`] = { t: 'topup', txt: `Abonnement de ${r.fn}`, a: r.a - fee, ts: now };
          U[`inbox/${ownerUid}/${nid('n')}`] = { txt: `💸 Nouvel abonné (${r.fn}) pour ${tid}`, ts: now };
        }

        // Ajouter l'abonné (valide 30 jours)
        U[`tunnels/${tid}/subscribers/${r.f}`] = { ts: now, exp: now + (30 * 24 * 60 * 60 * 1000) };
        U[`inbox/${r.f}/${nid('n')}`] = { txt: `✅ Abonnement validé pour ${tid}`, ts: now };
        
      } else {
        // Transfert classique (tr) ou Retrait (wd)
        let toId = null;
        if (r.t === 'tr') {
          toId = (await db.ref(`ids/${r.to}`).once('value')).val();
          if (!toId) { U[`transfer_requests/${key}/s`] = 'no'; await db.ref().update(U); continue; }
        }

        U[`users/${r.f}/bal`] = senderBal - r.a;
        U[`users/${r.f}/hist/${nid('h')}`] = { t: r.t, txt: r.t === 'wd' ? "Retrait" : "Envoi vers " + r.to, a: -r.a, ts: now };
        
        if (toId) {
          const toBal = (await db.ref(`users/${toId}/bal`).once('value')).val() || 0;
          U[`users/${toId}/bal`] = toBal + (r.a - fee);
          U[`users/${toId}/hist/${nid('h')}`] = { t: 'tr', txt: "Reçu de " + r.fn, a: r.a - fee, ts: now };
          U[`inbox/${toId}/${nid('n')}`] = { txt: `🎉 Reçu ${kc(r.a - fee)} de ${r.fn}`, ts: now };
        }

        // Commission Admin
        const adminBal = (await db.ref(`users/${ADMIN_UID}/bal`).once('value')).val() || 0;
        U[`users/${ADMIN_UID}/bal`] = adminBal + fee;
      }

      // Finalisation
      U[`transfer_requests/${key}/s`] = 'ok';
      U[`log/${nid('log')}`] = { by: 'robot', t: r.t, f: r.fn, a: r.a, fee, ts: now };
      
      await db.ref().update(U);
      console.log(`✅ Opération ${key} validée.`);

    } catch (e) {
      console.error(`Erreur sur ${key}:`, e);
      await db.ref(`transfer_requests/${key}/s`).transaction(cur => cur === 'work' ? 'p' : undefined).catch(() => {});
    }
  }
}

// Envoi des push inbox
async function pushInbox() {
  const snap = await db.ref('inbox').once('value');
  if (!snap.exists()) return;
  for (const [uid, items] of Object.entries(snap.val())) {
    const fresh = Object.entries(items).filter(([, n]) => !n.pushed && n.txt);
    if (!fresh.length) continue;
    const token = (await db.ref(`users/${uid}/fcmToken`).once('value')).val();
    for (const [nk, n] of fresh) {
      if (token) await sendPush(uid, token, "Mbolo 🥁", n.txt);
      await db.ref(`inbox/${uid}/${nk}/pushed`).set(true); 
    }
  }
}

(async () => {
  await processRequests();
  await pushInbox();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });