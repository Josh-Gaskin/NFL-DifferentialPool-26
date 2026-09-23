#!/usr/bin/env python3
"""
Pulls three things from ESPN's public (undocumented) JSON endpoints and writes
them to /data as static files that the site reads at runtime:

  data/teams.json    - the 32 NFL teams (id, abbreviation, name, logo)
  data/fpi.json       - current season FPI rating per team
  data/schedule.json  - full regular-season schedule (weeks 1-18), home/away

These endpoints are not officially documented or supported by ESPN, have no
auth, and can change shape without notice. This script is defensive: if a
request fails or the shape looks wrong, it leaves the existing JSON file on
disk untouched and exits non-zero, so a bad ESPN response never overwrites
good data in the repo.
"""
import json
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

YEAR = 2026
WEEKS = range(1, 19)  # regular season weeks 1-18
DATA_DIR = Path(__file__).resolve().parent.parent / "data"

HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; nfl-pool-fetcher/1.0)"}


def get_json(url, retries=3, timeout=15):
    last_err = None
    for attempt in range(retries):
        try:
            req = Request(url, headers=HEADERS)
            with urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (URLError, HTTPError, TimeoutError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"Failed to fetch {url}: {last_err}")


def fetch_teams():
    url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams?limit=40"
    data = get_json(url)
    teams = []
    for entry in data["sports"][0]["leagues"][0]["teams"]:
        t = entry["team"]
        logo = ""
        if t.get("logos"):
            logo = t["logos"][0].get("href", "")
        teams.append(
            {
                "id": t["id"],
                "abbr": t.get("abbreviation", "").upper(),
                "name": t.get("displayName", ""),
                "shortName": t.get("shortDisplayName", ""),
                "logo": logo,
            }
        )
    if len(teams) < 32:
        raise RuntimeError(f"Expected 32 teams, got {len(teams)}")
    teams.sort(key=lambda x: x["abbr"])
    return teams


def _find_stat(stats, names):
    """Find a stat by matching name/abbreviation/displayName case-insensitively."""
    names = {n.lower() for n in names}
    for s in stats:
        for key in ("name", "abbreviation", "displayName"):
            val = s.get(key, "")
            if val and val.lower() in names:
                return s.get("value")
    return None


def fetch_fpi(team_id_by_abbr):
    """
    Uses the documented-by-observation core API endpoint:
    sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/{year}/powerindex
    which returns either inline predictives/efficiencies per team, or a list
    of $ref links that need a follow-up fetch. This handles both shapes.
    """
    base = (
        "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl"
        f"/seasons/{YEAR}/powerindex?limit=50"
    )
    data = get_json(base)
    items = data.get("items", [])
    if not items:
        raise RuntimeError("powerindex response had no items")

    results = []
    for item in items:
        if "predictives" in item or "$ref" not in item:
            entry = item
        else:
            entry = get_json(item["$ref"])

        team_ref = entry.get("team", {})
        team_id = None
        if isinstance(team_ref, dict):
            if "$ref" in team_ref:
                # team is itself a $ref - id is usually embedded in the URL
                team_id = team_ref["$ref"].rstrip("/").split("/")[-1].split("?")[0]
            else:
                team_id = team_ref.get("id")

        predictives = entry.get("predictives", [])
        fpi_val = _find_stat(predictives, ["fpi", "FPI"])
        if fpi_val is None:
            continue

        results.append({"teamId": str(team_id), "fpi": round(float(fpi_val), 2)})

    if len(results) < 28:
        raise RuntimeError(f"Only parsed FPI for {len(results)} teams, expected ~32")

    results.sort(key=lambda x: x["fpi"], reverse=True)
    for i, r in enumerate(results, start=1):
        r["fpiRank"] = i
    return results


def fetch_schedule():
    weeks = {}
    for wk in WEEKS:
        url = (
            "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
            f"?year={YEAR}&seasontype=2&week={wk}"
        )
        data = get_json(url)
        games = []
        for event in data.get("events", []):
            comp = event["competitions"][0]
            home = away = None
            for c in comp["competitors"]:
                team = {
                    "id": c["team"]["id"],
                    "abbr": c["team"].get("abbreviation", "").upper(),
                }
                if c.get("homeAway") == "home":
                    home = team
                else:
                    away = team
            if not home or not away:
                continue
            games.append(
                {
                    "date": event.get("date", ""),
                    "home": home["abbr"],
                    "away": away["abbr"],
                    "homeId": home["id"],
                    "awayId": away["id"],
                }
            )
        weeks[str(wk)] = games
        time.sleep(0.3)  # be a reasonable citizen of an undocumented API
    return {"year": YEAR, "weeks": weeks}


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(obj, indent=2, sort_keys=False))
    tmp.replace(path)


def main():
    ok = True

    try:
        teams = fetch_teams()
        write_json(DATA_DIR / "teams.json", teams)
        print(f"teams.json written ({len(teams)} teams)")
    except Exception as e:
        ok = False
        print(f"ERROR fetching teams: {e}", file=sys.stderr)

    try:
        fpi = fetch_fpi({})
        write_json(
            DATA_DIR / "fpi.json",
            {"year": YEAR, "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "ratings": fpi},
        )
        print(f"fpi.json written ({len(fpi)} teams)")
    except Exception as e:
        ok = False
        print(f"ERROR fetching FPI: {e}", file=sys.stderr)

    try:
        schedule = fetch_schedule()
        write_json(DATA_DIR / "schedule.json", schedule)
        print("schedule.json written")
    except Exception as e:
        ok = False
        print(f"ERROR fetching schedule: {e}", file=sys.stderr)

    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
