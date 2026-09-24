// Firebase Console -> Project settings -> General -> "Your apps" -> SDK setup and configuration.
// This is safe to be public in a client-side app; Firestore security rules
// (see firestore.rules) are what actually restrict access, not this config.
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

// Pool configuration
export const YEAR = 2026;
export const TOTAL_WEEKS = 18;
export const DOUBLE_PICK_WEEKS = [1, 9, 12, 18]; // weeks where you pick 2 teams
export const HOME_FIELD_ADVANTAGE = 1.5; // points added to a team's FPI when playing at home
