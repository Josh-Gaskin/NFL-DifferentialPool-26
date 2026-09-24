// Firebase Console -> Project settings -> General -> "Your apps" -> SDK setup and configuration.
// This is safe to be public in a client-side app; Firestore security rules
// (see firestore.rules) are what actually restrict access, not this config.
export const firebaseConfig = {
  apiKey: "AIzaSyAdhluTRPGqjitojiNAYU0alPcccWHnrDM",
  authDomain: "nfl-differentialpool-26.firebaseapp.com",
  projectId: "nfl-differentialpool-26",
  storageBucket: "nfl-differentialpool-26.firebasestorage.app",
  messagingSenderId: "1089752558523",
  appId: "1:1089752558523:web:42b91d001025dcea99b29e"
};

// Pool configuration
export const YEAR = 2026;
export const TOTAL_WEEKS = 18;
export const DOUBLE_PICK_WEEKS = [1, 9, 12, 18]; // weeks where you pick 2 teams
export const HOME_FIELD_ADVANTAGE = 1.5; // points added to a team's FPI when playing at home
