/**
 * Hungarian algorithm (Kuhn-Munkres) for the assignment problem, minimizing
 * total cost. Handles rectangular matrices (rows >= cols) by treating rows
 * as "workers" (teams) and cols as "jobs" (pick slots).
 *
 * cost: number[rows][cols], where rows >= cols. Use a large number
 * (e.g. Infinity-ish, see INFEASIBLE below) for pairs that must never be
 * chosen (e.g. a team that's on a bye that week).
 *
 * Returns: array of length cols, where result[j] = row index assigned to
 * column j (the team assigned to that pick slot).
 *
 * Implementation: classic O(n^3) potential-based algorithm (as in
 * cp-algorithms.com "Assignment problem, Hungarian algorithm"), adapted for
 * rows >= cols by solving on a square matrix padded with zero-cost dummy
 * columns, then discarding assignments to the dummies.
 */

export const INFEASIBLE = 1e6;

export function hungarianAssign(costIn) {
  const rows = costIn.length;
  const cols = rows ? costIn[0].length : 0;
  if (rows === 0 || cols === 0) return [];

  const n = rows; // square size = number of teams (rows >= cols assumed)
  const m = n;    // pad columns up to n with zero-cost dummies

  // a[1..n][1..m], 1-indexed as in the reference algorithm
  const a = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= rows; i++) {
    for (let j = 1; j <= m; j++) {
      a[i][j] = j <= cols ? costIn[i - 1][j - 1] : 0;
    }
  }

  const INF = Infinity;
  const u = new Array(n + 1).fill(0);
  const v = new Array(m + 1).fill(0);
  const p = new Array(m + 1).fill(0);   // p[j] = row currently matched to col j
  const way = new Array(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF);
    const used = new Array(m + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = -1;
      for (let j = 1; j <= m; j++) {
        if (!used[j]) {
          const cur = a[i0][j] - u[i0] - v[j];
          if (cur < minv[j]) {
            minv[j] = cur;
            way[j] = j0;
          }
          if (minv[j] < delta) {
            delta = minv[j];
            j1 = j;
          }
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0 !== 0);
  }

  // p[j] = row (1-indexed) assigned to column j. Build row->col map, then
  // return per real-column (1..cols) assignment as 0-indexed row, or -1.
  const rowForCol = new Array(cols).fill(-1);
  for (let j = 1; j <= cols; j++) {
    rowForCol[j - 1] = p[j] - 1;
  }
  return rowForCol;
}
