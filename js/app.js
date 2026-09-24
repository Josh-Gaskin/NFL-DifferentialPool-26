import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  doc,
  setDoc,
  updateDoc,
  deleteField,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";

import {
  firebaseConfig,
  YEAR,
  TOTAL_WEEKS,
  DOUBLE_PICK_WEEKS,
  HOME_FIELD_ADVANTAGE,
} from "./firebase-config.js";
import { hungarianAssign, INFEASIBLE } from "./hungarian.js";

// ---------- Firebase setup ----------
const app = initializeApp(firebaseConfig);

// Persistent (IndexedDB-backed) local cache: on repeat visits, onSnapshot's
// first callback can fire from what's already on disk instead of waiting on
// a round trip to Firestore's servers, so a refresh shows your picks
// near-instantly. Falls back to the plain in-memory client if the browser
// doesn't support it (e.g. some private-browsing modes).
let db;
try {
  db = initializeFirestore(app, { localCache: persistentLocalCache() });
} catch (e) {
  console.warn("Persistent Firestore cache unavailable, using in-memory client:", e);
  db = getFirestore(app);
}
const picksRef = doc(db, "picks", String(YEAR));

// ---------- Pool state ----------
let teams = [];          // [{id, abbr, name, shortName, logo}]
let fpiByAbbr = {};       // { BUF: 12.3, ... }
let fpiUpdated = null;
let scheduleIndex = {};   // { [week]: { [abbr]: {opponent, isHome, completed, myScore, oppScore, actualDiff} } }
let lockedSlots = {};     // Firestore data: { [slotId]: {team, week, opponent, isHome, predictedDiff, actualDiff?} }
let editingResults = new Set(); // slot ids currently showing the manual-score inputs
let matrixMode = "matchup"; // "matchup" | "diff"
let activeTab = "picks";    // "picks" | "matrix"
let lastPlan = {};          // cached optimizer output, reused so tab switches don't recompute

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
      const completed = !!g.completed;
      const homeDiff = completed && g.homeScore != null && g.awayScore != null ? g.homeScore - g.awayScore : null;
      const awayDiff = homeDiff != null ? -homeDiff : null;
      scheduleIndex[week][g.home] = {
        opponent: g.away, isHome: true, completed,
        myScore: g.homeScore, oppScore: g.awayScore, actualDiff: homeDiff,
      };
      scheduleIndex[week][g.away] = {
        opponent: g.home, isHome: false, completed,
        myScore: g.awayScore, oppScore: g.homeScore, actualDiff: awayDiff,
      };
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

// Auto-pulled result for a team in a given week, straight from ESPN data.
function getAutoResult(abbr, week) {
  const game = (scheduleIndex[week] || {})[abbr];
  if (!game || !game.completed || game.actualDiff == null) return null;
  return { myScore: game.myScore, oppScore: game.oppScore, diff: game.actualDiff };
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

// Manual override of the auto-pulled result (or manual entry if auto data
// isn't available yet for some reason).
async function recordResult(slotId, myScore, oppScore) {
  const actualDiff = myScore - oppScore;
  await updateDoc(picksRef, {
    [`slots.${slotId}.homeScoreEntry`]: myScore,
    [`slots.${slotId}.oppScoreEntry`]: oppScore,
    [`slots.${slotId}.actualDiff`]: actualDiff,
  });
}

// Clears a manual override so the row falls back to the auto-pulled result.
async function clearManualOverride(slotId) {
  await updateDoc(picksRef, {
    [`slots.${slotId}.homeScoreEntry`]: deleteField(),
    [`slots.${slotId}.oppScoreEntry`]: deleteField(),
    [`slots.${slotId}.actualDiff`]: deleteField(),
  });
}

// ---------- Rendering: Picks tab ----------
const el = (sel) => document.querySelector(sel);

function renderPicks(plan) {
  const lockedTeamSet = new Set(Object.values(lockedSlots).map((s) => s.team));

  let actualTotal = 0;
  let pendingLockedPredicted = 0;
  let remainingProjected = 0;

  const rows = SLOTS.map((slot) => {
    const locked = lockedSlots[slot.id];
    let rowHtml;

    if (locked) {
      const manualDiff = locked.actualDiff !== undefined && locked.actualDiff !== null ? locked.actualDiff : null;
      const auto = getAutoResult(locked.team, locked.week);
      const effectiveDiff = manualDiff != null ? manualDiff : (auto ? auto.diff : null);
      const source = manualDiff != null ? "manual" : (auto ? "auto" : null);

      if (effectiveDiff != null) actualTotal += effectiveDiff;
      else pendingLockedPredicted += locked.predictedDiff ?? 0;

      const team = teams.find((t) => t.abbr === locked.team);
      const isEditing = editingResults.has(slot.id);

      let resultCell;
      if (isEditing) {
        resultCell = `
          <input type="number" placeholder="your pts" data-my-score="${slot.id}" class="score-input">
          <input type="number" placeholder="opp pts" data-opp-score="${slot.id}" class="score-input">
          <button data-action="save-result" data-slot="${slot.id}">save</button>
          <button data-action="cancel-edit" data-slot="${slot.id}">cancel</button>`;
      } else if (effectiveDiff != null) {
        resultCell = `
          <span class="actual-diff ${effectiveDiff <= 0 ? "good" : "bad"}">${fmtDiff(effectiveDiff)}</span>
          <span class="source-tag">${source === "auto" ? "auto" : "manual"}</span>
          <button data-action="toggle-edit" data-slot="${slot.id}">edit</button>
          ${source === "manual" ? `<button data-action="clear-override" data-slot="${slot.id}">use auto</button>` : ""}
        `;
      } else {
        resultCell = `<span class="pending">pending</span> <button data-action="toggle-edit" data-slot="${slot.id}">enter score</button>`;
      }

      rowHtml = `
        <tr class="locked">
          <td>${slot.label}</td>
          <td class="team-cell">${logoImg(team)} ${locked.team}</td>
          <td>${locked.opponent ? (locked.isHome ? "vs " : "@ ") + locked.opponent : "-"}</td>
          <td>${fmtDiff(locked.predictedDiff)}</td>
          <td class="result-cell">${resultCell}</td>
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
    <div class="summary-card"><span>Actual total (results in)</span><strong>${fmtDiff(actualTotal)}</strong></div>
    <div class="summary-card"><span>Locked, awaiting result</span><strong>${fmtDiff(pendingLockedPredicted)}</strong></div>
    <div class="summary-card"><span>Remaining (optimizer projection)</span><strong>${fmtDiff(remainingProjected)}</strong></div>
    <div class="summary-card total"><span>Projected season total</span><strong>${fmtDiff(grandTotal)}</strong></div>
    <div class="summary-card"><span>Data last updated</span><strong>${fpiUpdated ? new Date(fpiUpdated).toLocaleString() : "not yet run"}</strong></div>
  `;

  attachPicksHandlers();
}

function logoImg(team) {
  return team && team.logo
    ? `<img src="${team.logo}" class="logo" alt="" width="20" height="20" loading="lazy">`
    : "";
}

function fmtDiff(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  const rounded = Math.round(n * 10) / 10;
  return (rounded > 0 ? "+" : "") + rounded;
}

function attachPicksHandlers() {
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
  document.querySelectorAll("[data-action='toggle-edit']").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingResults.add(btn.dataset.slot);
      render();
    });
  });
  document.querySelectorAll("[data-action='cancel-edit']").forEach((btn) => {
    btn.addEventListener("click", () => {
      editingResults.delete(btn.dataset.slot);
      render();
    });
  });
  document.querySelectorAll("[data-action='save-result']").forEach((btn) => {
    btn.addEventListener("click", () => {
      const slotId = btn.dataset.slot;
      const my = parseFloat(document.querySelector(`[data-my-score="${slotId}"]`).value);
      const opp = parseFloat(document.querySelector(`[data-opp-score="${slotId}"]`).value);
      if (Number.isNaN(my) || Number.isNaN(opp)) return alert("Enter both scores.");
      editingResults.delete(slotId);
      recordResult(slotId, my, opp);
    });
  });
  document.querySelectorAll("[data-action='clear-override']").forEach((btn) => {
    btn.addEventListener("click", () => clearManualOverride(btn.dataset.slot));
  });
}

// ---------- Rendering: Schedule Matrix tab ----------
function diffColorClass(n) {
  if (n == null || Number.isNaN(n)) return "";
  if (n <= -14) return "diff-vgood";
  if (n <= -7) return "diff-good";
  if (n <= -1) return "diff-mildgood";
  if (n < 1) return "diff-neutral";
  if (n < 7) return "diff-mildbad";
  if (n < 14) return "diff-bad";
  return "diff-vbad";
}

function renderMatrix(plan) {
  const lockedMap = {};   // `${team}_${week}` -> true
  Object.values(lockedSlots).forEach((s) => { lockedMap[`${s.team}_${s.week}`] = true; });

  const recMap = {};      // `${team}_${week}` -> true
  SLOTS.forEach((slot) => {
    const rec = plan[slot.id];
    if (rec) recMap[`${rec.team}_${slot.week}`] = true;
  });

  const weeks = Array.from({ length: TOTAL_WEEKS }, (_, i) => i + 1);

  const headerHtml = `
    <tr>
      <th class="sticky-col">Team</th>
      ${weeks.map((w) => `<th>${DOUBLE_PICK_WEEKS.includes(w) ? `Wk ${w} <span class="two-pick">(2 picks)</span>` : `Wk ${w}`}</th>`).join("")}
    </tr>`;

  const bodyHtml = teams
    .map((t) => {
      const cells = weeks
        .map((w) => {
          const game = (scheduleIndex[w] || {})[t.abbr];
          if (!game) return `<td class="bye">BYE</td>`;

          const isLocked = !!lockedMap[`${t.abbr}_${w}`];
          const isRec = !!recMap[`${t.abbr}_${w}`];
          const classes = [isLocked ? "picked" : "", isRec && !isLocked ? "recommended" : ""].filter(Boolean).join(" ");

          if (matrixMode === "matchup") {
            const content = `<span class="ha">${game.isHome ? "v" : "@"}</span>${game.opponent}`;
            return `<td class="${classes}" title="${t.abbr} ${game.isHome ? "vs" : "at"} ${game.opponent}, week ${w}">${content}</td>`;
          } else {
            const diff = predictedMargin(t.abbr, w);
            return `<td class="${classes} ${diffColorClass(diff)}" title="${t.abbr} ${game.isHome ? "vs" : "at"} ${game.opponent}, week ${w}">${fmtDiff(diff)}</td>`;
          }
        })
        .join("");
      return `<tr><td class="sticky-col team-cell">${logoImg(t)} ${t.abbr}</td>${cells}</tr>`;
    })
    .join("");

  el("#matrix-table thead").innerHTML = headerHtml;
  el("#matrix-table tbody").innerHTML = bodyHtml;
}

// ---------- Tabs & matrix mode toggle ----------
document.querySelectorAll("[data-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    activeTab = btn.dataset.tab;
    el("#picks-view").classList.toggle("hidden", activeTab !== "picks");
    el("#matrix-view").classList.toggle("hidden", activeTab !== "matrix");
    if (activeTab === "matrix") renderMatrix(lastPlan); // build it on demand, not on every load
  });
});

document.querySelectorAll("[data-matrix-mode]").forEach((btn) => {
  btn.addEventListener("click", () => {
    matrixMode = btn.dataset.matrixMode;
    document.querySelectorAll("[data-matrix-mode]").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderMatrix(lastPlan);
  });
});

// ---------- Top-level render ----------
function render() {
  lastPlan = computeOptimalPlan();
  renderPicks(lastPlan);
  if (activeTab === "matrix") renderMatrix(lastPlan); // skip building it (and its images) while on the Picks tab
}

// ---------- Startup ----------
(async function init() {
  await loadStaticData();
  render(); // first paint using local JSON only — don't wait on Firestore's round trip
  onSnapshot(picksRef, (snap) => {
    lockedSlots = snap.exists() ? snap.data().slots || {} : {};
    render();
  });
})();
