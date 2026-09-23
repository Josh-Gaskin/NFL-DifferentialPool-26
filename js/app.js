import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getFirestore,
  doc,
  setDoc,
  updateDoc,
  deleteField,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import {
  firebaseConfig,
  ALLOWED_EMAILS,
  YEAR,
  TOTAL_WEEKS,
  DOUBLE_PICK_WEEKS,
  HOME_FIELD_ADVANTAGE,
} from "./firebase-config.js";
import { hungarianAssign, INFEASIBLE } from "./hungarian.js";

// ---------- Firebase setup ----------
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const picksRef = doc(db, "picks", String(YEAR));

// ---------- Pool state ----------
let teams = [];          // [{id, abbr, name, shortName, logo}]
let fpiByAbbr = {};       // { BUF: 12.3, ... }
let fpiUpdated = null;
let scheduleIndex = {};   // { [week]: { [abbr]: {opponent, isHome} } }
let lockedSlots = {};     // Firestore data: { [slotId]: {team, week, predictedDiff, homeScore, awayScore, actualDiff} }
let currentUser = null;

const SLOTS = buildSlots();

function buildSlots() {
  const slots = [];
  for (let w = 1; w <= TOTAL_WEEKS; w++) {
    if (DOUBLE_PICK_WEEKS.includes(w)) {
      slots.push({ id: `${w}a`, week: w, label: `Week ${w} (Pick A)` });
      slots.push({ id: `${w}b`, week: w, label: `Week ${w} (Pick B)` });
    } else {
      slots.push({ id: `${w}`, week: w, label: `Week ${w}` });
    }
  }
  return slots;
}

// ---------- Data loading ----------
async function loadStaticData() {
  const [teamsRes, fpiRes, scheduleRes] = await Promise.all([
    fetch("data/teams.json").then((r) => r.json()),
    fetch("data/fpi.json").then((r) => r.json()),
    fetch("data/schedule.json").then((r) => r.json()),
  ]);

  teams = teamsRes;
  fpiUpdated = fpiRes.updated;

  const teamIdToAbbr = Object.fromEntries(teams.map((t) => [String(t.id), t.abbr]));
  fpiByAbbr = {};
  for (const r of fpiRes.ratings || []) {
    const abbr = teamIdToAbbr[String(r.teamId)];
    if (abbr) fpiByAbbr[abbr] = r.fpi;
  }

  scheduleIndex = {};
  for (const [week, games] of Object.entries(scheduleRes.weeks || {})) {
    scheduleIndex[week] = {};
    for (const g of games) {
      scheduleIndex[week][g.home] = { opponent: g.away, isHome: true };
      scheduleIndex[week][g.away] = { opponent: g.home, isHome: false };
    }
  }
}

function predictedMargin(abbr, week) {
  const game = (scheduleIndex[week] || {})[abbr];
  if (!game) return null; // bye week
  const mine = fpiByAbbr[abbr];
  const theirs = fpiByAbbr[game.opponent];
  if (mine == null || theirs == null) return null;
  const hfa = game.isHome ? HOME_FIELD_ADVANTAGE : -HOME_FIELD_ADVANTAGE;
  return mine - theirs + hfa;
}

// ---------- Optimizer ----------
// Returns a map: slotId -> { team, predictedDiff } representing the
// lowest-total-differential assignment of remaining teams to remaining slots.
function computeOptimalPlan() {
  const lockedTeamSet = new Set(Object.values(lockedSlots).map((s) => s.team));
  const openSlots = SLOTS.filter((s) => !lockedSlots[s.id]);
  const availableTeams = teams.filter((t) => !lockedTeamSet.has(t.abbr));

  const plan = {};
  if (openSlots.length === 0 || availableTeams.length === 0) return plan;

  const costMatrix = availableTeams.map((t) =>
    openSlots.map((s) => {
      const m = predictedMargin(t.abbr, s.week);
      return m === null ? INFEASIBLE : m;
    })
  );

  const assignment = hungarianAssign(costMatrix); // length = openSlots.length, value = row index
  openSlots.forEach((slot, j) => {
    const rowIdx = assignment[j];
    if (rowIdx == null || rowIdx < 0 || rowIdx >= availableTeams.length) return;
    const team = availableTeams[rowIdx];
    const diff = costMatrix[rowIdx][j];
    if (diff >= INFEASIBLE) return; // no valid game found for this team/slot
    plan[slot.id] = { team: team.abbr, predictedDiff: diff };
  });
  return plan;
}

// ---------- Firestore writes ----------
async function lockPick(slotId, teamAbbr) {
  const slot = SLOTS.find((s) => s.id === slotId);
  const diff = predictedMargin(teamAbbr, slot.week);
  const game = (scheduleIndex[slot.week] || {})[teamAbbr] || {};
  await setDoc(
    picksRef,
    {
      slots: {
        [slotId]: {
          team: teamAbbr,
          week: slot.week,
          opponent: game.opponent || null,
          isHome: !!game.isHome,
          predictedDiff: diff,
          locked: true,
        },
      },
    },
    { merge: true }
  );
}

async function unlockPick(slotId) {
  await updateDoc(picksRef, { [`slots.${slotId}`]: deleteField() });
}

async function recordResult(slotId, myScore, oppScore) {
  const actualDiff = myScore - oppScore;
  await updateDoc(picksRef, {
    [`slots.${slotId}.homeScoreEntry`]: myScore,
    [`slots.${slotId}.oppScoreEntry`]: oppScore,
    [`slots.${slotId}.actualDiff`]: actualDiff,
  });
}

async function clearResult(slotId) {
  await updateDoc(picksRef, {
    [`slots.${slotId}.homeScoreEntry`]: deleteField(),
    [`slots.${slotId}.oppScoreEntry`]: deleteField(),
    [`slots.${slotId}.actualDiff`]: deleteField(),
  });
}

// ---------- Rendering ----------
const el = (sel) => document.querySelector(sel);

function render() {
  if (!currentUser) return;
  const plan = computeOptimalPlan();
  const lockedTeamSet = new Set(Object.values(lockedSlots).map((s) => s.team));

  let actualTotal = 0;
  let pendingLockedPredicted = 0;
  let remainingProjected = 0;

  const rows = SLOTS.map((slot) => {
    const locked = lockedSlots[slot.id];
    let rowHtml;

    if (locked) {
      const hasResult = locked.actualDiff !== undefined && locked.actualDiff !== null;
      if (hasResult) actualTotal += locked.actualDiff;
      else pendingLockedPredicted += locked.predictedDiff ?? 0;

      const team = teams.find((t) => t.abbr === locked.team);
      rowHtml = `
        <tr class="locked">
          <td>${slot.label}</td>
          <td class="team-cell">${logoImg(team)} ${locked.team}</td>
          <td>${locked.opponent ? (locked.isHome ? "vs " : "@ ") + locked.opponent : "-"}</td>
          <td>${fmtDiff(locked.predictedDiff)}</td>
          <td class="result-cell">
            ${hasResult
              ? `<span class="actual-diff ${locked.actualDiff <= 0 ? "good" : "bad"}">${fmtDiff(locked.actualDiff)}</span>
                 <button data-action="clear-result" data-slot="${slot.id}">edit</button>`
              : `<input type="number" placeholder="your pts" data-my-score="${slot.id}" class="score-input">
                 <input type="number" placeholder="opp pts" data-opp-score="${slot.id}" class="score-input">
                 <button data-action="save-result" data-slot="${slot.id}">save</button>`
            }
          </td>
          <td><button data-action="unlock" data-slot="${slot.id}">Unlock</button></td>
        </tr>`;
    } else {
      const rec = plan[slot.id];
      if (rec) remainingProjected += rec.predictedDiff;

      const weekTeams = Object.keys(scheduleIndex[slot.week] || {})
        .filter((abbr) => !lockedTeamSet.has(abbr))
        .map((abbr) => ({ abbr, diff: predictedMargin(abbr, slot.week) }))
        .sort((a, b) => a.diff - b.diff);

      const options = weekTeams
        .map(
          (t) =>
            `<option value="${t.abbr}" ${rec && rec.team === t.abbr ? "selected" : ""}>
              ${t.abbr} (${fmtDiff(t.diff)})${rec && rec.team === t.abbr ? " \u2605 recommended" : ""}
            </option>`
        )
        .join("");

      rowHtml = `
        <tr>
          <td>${slot.label}</td>
          <td colspan="3">
            <select data-slot-select="${slot.id}">
              <option value="">-- choose team --</option>
              ${options}
            </select>
          </td>
          <td>-</td>
          <td><button data-action="lock" data-slot="${slot.id}">Lock in</button></td>
        </tr>`;
    }
    return rowHtml;
  }).join("");

  el("#picks-table tbody").innerHTML = rows;

  const grandTotal = actualTotal + pendingLockedPredicted + remainingProjected;
  el("#summary").innerHTML = `
    <div class="summary-card"><span>Actual total (results entered)</span><strong>${fmtDiff(actualTotal)}</strong></div>
    <div class="summary-card"><span>Locked, awaiting result</span><strong>${fmtDiff(pendingLockedPredicted)}</strong></div>
    <div class="summary-card"><span>Remaining (optimizer projection)</span><strong>${fmtDiff(remainingProjected)}</strong></div>
    <div class="summary-card total"><span>Projected season total</span><strong>${fmtDiff(grandTotal)}</strong></div>
    <div class="summary-card"><span>FPI last updated</span><strong>${fpiUpdated ? new Date(fpiUpdated).toLocaleDateString() : "not yet run"}</strong></div>
  `;

  attachRowHandlers();
}

function logoImg(team) {
  return team && team.logo ? `<img src="${team.logo}" class="logo" alt="">` : "";
}

function fmtDiff(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const rounded = Math.round(n * 10) / 10;
  return (rounded > 0 ? "+" : "") + rounded;
}

function attachRowHandlers() {
  document.querySelectorAll("[data-action='lock']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slotId = btn.dataset.slot;
      const select = document.querySelector(`[data-slot-select="${slotId}"]`);
      if (!select.value) return alert("Choose a team first.");
      lockPick(slotId, select.value);
    });
  });
  document.querySelectorAll("[data-action='unlock']").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (confirm("Unlock this pick? The team becomes available again.")) {
        unlockPick(btn.dataset.slot);
      }
    });
  });
  document.querySelectorAll("[data-action='save-result']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slotId = btn.dataset.slot;
      const my = parseFloat(document.querySelector(`[data-my-score="${slotId}"]`).value);
      const opp = parseFloat(document.querySelector(`[data-opp-score="${slotId}"]`).value);
      if (Number.isNaN(my) || Number.isNaN(opp)) return alert("Enter both scores.");
      recordResult(slotId, my, opp);
    });
  });
  document.querySelectorAll("[data-action='clear-result']").forEach((btn) => {
    btn.addEventListener("click", () => clearResult(btn.dataset.slot));
  });
}

// ---------- Auth ----------
el("#sign-in-btn")?.addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch((e) => alert(e.message));
});
el("#sign-out-btn")?.addEventListener("click", () => signOut(auth));

onAuthStateChanged(auth, async (user) => {
  currentUser = user && ALLOWED_EMAILS.includes(user.email) ? user : null;

  el("#signed-out-view").classList.toggle("hidden", !!user);
  el("#not-authorized-view").classList.toggle("hidden", !user || !!currentUser);
  el("#app-view").classList.toggle("hidden", !currentUser);

  if (currentUser) {
    el("#whoami").textContent = currentUser.email;
    await loadStaticData();
    onSnapshot(picksRef, (snap) => {
      lockedSlots = snap.exists() ? snap.data().slots || {} : {};
      render();
    });
  }
});
