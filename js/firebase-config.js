// Import the functions you need from the SDKs you need

import { initializeApp } from "firebase/app";

// TODO: Add SDKs for Firebase products that you want to use

// https://firebase.google.com/docs/web/setup#available-libraries


// Your web app's Firebase configuration

const firebaseConfig = {

  apiKey: "AIzaSyAdhluTRPGqjitojiNAYU0alPcccWHnrDM",

  authDomain: "nfl-differentialpool-26.firebaseapp.com",

  projectId: "nfl-differentialpool-26",

  storageBucket: "nfl-differentialpool-26.firebasestorage.app",

  messagingSenderId: "1089752558523",

  appId: "1:1089752558523:web:42b91d001025dcea99b29e"

};


// Initialize Firebase

const app = initializeApp(firebaseConfig);

// Pool configuration
export const YEAR = 2026;
export const TOTAL_WEEKS = 18;
export const DOUBLE_PICK_WEEKS = [1, 9, 12, 18]; // weeks where you pick 2 teams
export const HOME_FIELD_ADVANTAGE = 1.5; // points added to a team's FPI when playing at home
