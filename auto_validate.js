const admin = require('firebase-admin');
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://mbolo-81868-default-rtdb.firebaseio.com"
});

const db = admin.database();
const ADMIN_UID = 'urGWEwETbaMavqbu7jwa6fToUXz2'; // Ton UID d'admin
const COMMISSION_RATE = 0.03;

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

    } catch (error) {
      console.error(`Erreur sur la demande ${key}:`, error);
    }
  }
  process.exit(0);
}

processTransfers();
