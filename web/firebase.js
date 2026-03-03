import { initializeApp, cert, applicationDefault, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

console.log("[firebase.js] Initializing Firebase...");

let credential;
if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
  console.log("[firebase.js] Parsing GOOGLE_APPLICATION_CREDENTIALS_JSON from env");
  const parsed = JSON.parse(
    Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, "base64").toString()
  );
  credential = cert(parsed);
} else {
  console.warn("[firebase.js] GOOGLE_APPLICATION_CREDENTIALS_JSON not set, trying applicationDefault()");
  credential = applicationDefault();
}

if (getApps().length === 0) {
  console.log("[firebase.js] No existing apps found, initializing new Firebase app", { projectId: process.env.GOOGLE_CLOUD_PROJECT });
  initializeApp({
    credential,
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
  });
  console.log("[firebase.js] Firebase app initialized successfully");
} else {
  console.log("[firebase.js] Firebase app already initialized, reusing existing");
}

export const db = getFirestore();
console.log("[firebase.js] Firestore instance obtained");
