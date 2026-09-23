# NFL Point Differential Pool Dashboard

A dashboard for a two-person NFL pool: each week you pick one team (two teams
in weeks 1, 9, 12, 18), each team can be used once all season, and the goal is
the **lowest total point differential** (your picked team's score minus their
opponent's — negative is good, since you want your teams to lose big).

The optimizer uses ESPN's FPI ratings to project every remaining game and
solves for the assignment of your remaining teams to remaining weeks that
minimizes your total projected differential (a proper assignment-problem
solve via the Hungarian algorithm — not a greedy week-by-week guess).

Runs entirely on free tiers:
- **GitHub Actions** (free for public repos) fetches FPI + schedule weekly and commits it as JSON.
- **GitHub Pages** (free) hosts the static site.
- **Firebase Spark plan** (free, no card required) handles Google sign-in and stores your locked-in picks so you and your partner both see live updates. No Cloud Functions are used (Spark doesn't include them), so everything here works without ever touching the paid Blaze plan.

## 1. Firebase setup

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project** (free, no billing needed for what we use).
2. **Build → Authentication → Get started → Sign-in method → Google → Enable.**
3. **Build → Firestore Database → Create database → Start in production mode** (any region near you).
4. **Project settings (gear icon) → General → Your apps → Web (`</>`)** → register an app (no Hosting needed) → copy the `firebaseConfig` object.
5. Paste those values into `js/firebase-config.js`, replacing the placeholders. Also set `ALLOWED_EMAILS` to your two Google account emails.
6. Put the **same two emails** into `firestore.rules` (the `isAllowed()` function). This is what actually enforces access — the JS file just controls the UI.
7. Deploy the rules. Easiest way, no local install required: in the Firestore Database page, click **Rules** tab, paste the contents of `firestore.rules`, and click **Publish**.
8. Back in **Authentication → Settings → Authorized domains**, add your GitHub Pages domain (e.g. `yourusername.github.io`) once you know it from step 3 below.

## 2. Push to GitHub & enable Pages

1. Create a new GitHub repo and push this folder to it.
2. **Repo Settings → Pages → Source: Deploy from a branch → Branch: `main`, folder: `/ (root)`.** Save. Your site will be at `https://yourusername.github.io/reponame/`.
3. Add that domain to Firebase Authentication's authorized domains list (step 8 above), or Google sign-in will be blocked.

## 3. Run the data pipeline once manually

The site ships with empty placeholder JSON in `data/`. Populate it immediately rather than waiting for next Tuesday's scheduled run:

1. Go to the repo's **Actions** tab → **Update FPI & Schedule Data** → **Run workflow**.
2. Check the run succeeded and that `data/fpi.json`, `data/schedule.json`, `data/teams.json` were committed with real content.

The workflow re-runs automatically every Tuesday. You can also trigger it manually any time from the Actions tab if you want fresher FPI numbers before making a pick.

## Notes & known limitations (v1)

- **ESPN's endpoints are undocumented.** They're the free JSON APIs that power espn.com itself, not an official supported API, so ESPN could change the response shape without notice. `scripts/fetch_data.py` is defensive (it won't overwrite good data with a bad/partial fetch) but if ESPN changes something, the Action will start failing — check the Actions tab occasionally, especially early in the season.
- **Actual results are entered by hand.** After a locked pick's game finishes, type in both teams' final scores in the "Actual Result" column. (A future version could pull final scores from ESPN's scoreboard automatically — happy to add that if useful.)
- **Home-field advantage** is a flat `+2.0` FPI-equivalent points, adjustable in `js/firebase-config.js` (`HOME_FIELD_ADVANTAGE`). ESPN's own FPI game predictor uses a more nuanced model; this is a reasonable simplification for pool strategy purposes.
- **Access is hardcoded to two emails.** There's no general user system — this is intentionally just for you and your partner.
- If you send over your spreadsheet, I can adjust the optimizer's assumptions (HFA value, bye-week handling, whatever scoring nuance you've been tracking) to match exactly how you've been doing it by hand.
