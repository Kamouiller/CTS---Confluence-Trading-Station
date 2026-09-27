// ⚠️ Remplace les valeurs ci-dessous par celles de TON projet Firebase
// (Console Firebase > Paramètres du projet > Vos applications > SDK setup and configuration)
const firebaseConfig = {
  apiKey: "AIzaSyBAObg6DpcCVBPsU0PPpuAbpPktodA8S4s",
  authDomain: "gtc---grand-trading-center.firebaseapp.com",
  projectId: "gtc---grand-trading-center",
  storageBucket: "gtc---grand-trading-center.firebasestorage.app",
  messagingSenderId: "523778533474",
  appId: "1:523778533474:web:0a94f9ab5f2b43e9cd893b"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
