const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://mbolo-81868-default-rtdb.firebaseio.com"
});

const db = admin.database();
const ADMIN_UID = 'urGWEwETbaMavqbu7jwa6fToUXz2'; 
const COMMISSION_RATE = 0.03;

// Fonction pour envoyer la notification push via FCM
async function sendPush(fcmToken, title, body) {
  if (!fcmToken) return;
  const serverKey = process.env.FCM_SERVER_KEY; 
  if (!serverKey) {
    console.log("⚠️ Clé FCM_SERVER_KEY manquante dans les secrets GitHub.");
    return;
  }
  
  try {
    const res = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': 'key=' + serverKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: fcmToken,
        notification: { title: title, body: body }
      })
    });
    if (!res.ok) console.error("Erreur FCM HTTP", await res.text());
  } catch (e) { console.error("Erreur Push", e); }
}

async function processTransfers() {
  console.log("Recherche des demandes en attente...");
  const requestsRef = db.ref('transfer_requests');
  const snapshot = await requestsRef.orderByChild('s').equalTo('p').once('value');

  if (!snapshot.exists()) {
    console.log("Aucune demande en attente. Fin du script.");
    process.exit(0);
  }

  const requests = snapshot.val();
  
  for (const [key, req] of Object.entries(requests)) {
    try {
      console.log(`Traitement de la demande ${key} pour ${req.fn}...`);
      
      // 1. Vérifier le solde
      const senderBalSnap = await db.ref(`users/${req.f}/bal`).once('value');
      const senderBal = senderBalSnap.val() || 0;
      
      if (senderBal < req.a) {
        console.log(`Solde insuffisant pour ${req.fn}. Refusé.`);
        await db.ref(`transfer_requests/${key}`).update({ s: 'no' });
        continue;
      }

      // 2. Trouver le destinataire
      const receiverIdSnap = await db.ref(`ids/${req.to}`).once('value');
      const receiverId = receiverIdSnap.val();
      
      if (!receiverId) {
        console.log(`Destinataire ${req.to} introuvable. Refusé.`);
        await db.ref(`transfer_requests/${key}`).update({ s: 'no' });
        continue;
      }

      // 3. Exécuter la transaction (Débit + Crédit)
      const amount = req.a;
      let amountForSeller = amount;
      let commission = 0;

      if (req.t === 'wd') {
        commission = Math.round(amount * COMMISSION_RATE);
        amountForSeller = amount - commission;
      }

      // Débiter l'acheteur
      await db.ref(`users/${req.f}/bal`).transaction(curr => curr - amount);
      // Créditer le vendeur/destinataire
      await db.ref(`users/${receiverId}/bal`).transaction(curr => (curr || 0) + amountForSeller);
      
      // Si commission, créditer l'admin
      if (commission > 0) {
        await db.ref(`users/${ADMIN_UID}/bal`).transaction(curr => (curr || 0) + commission);
      }

      // 4. Marquer comme validé
      await db.ref(`transfer_requests/${key}`).update({ s: 'ok' });
      console.log(`Succès : ${req.fn} a envoyé ${amount/10} KC au code ${req.to}.`);

      // --- ENVOI DES NOTIFICATIONS PUSH ---
      
      // Récupérer le token du destinataire et de l'expéditeur
      const receiverSnap = await db.ref(`users/${receiverId}`).once('value');
      const senderSnap = await db.ref(`users/${req.f}`).once('value');
      
      const receiverData = receiverSnap.val();
      const senderData = senderSnap.val();

      // Notification au destinataire (le vendeur)
      if (receiverData && receiverData.fcmToken) {
        await sendPush(
          receiverData.fcmToken, 
          "💰 Argent reçu !", 
          `Tu as reçu ${amountForSeller/10} KC de ${req.fn}.`
        );
      }

      // Notification à l'expéditeur (l'acheteur)
      if (senderData && senderData.fcmToken) {
        await sendPush(
          senderData.fcmToken, 
          "✅ Opération validée", 
          `Ton envoi de ${amount/10} KC vers ${req.to} a été validé.`
        );
      }

    } catch (error) {
      console.error(`Erreur sur la demande ${key}:`, error);
    }
  }
  process.exit(0);
}

processTransfers();