// Line diff for the scratchpad's Compare view.

// Above this many table cells (about 4000 x 4000 differing lines) the lines aren't aligned.
const DIFF_MAX_CELLS = 16_000_000;

// Compares two texts line by line. Returns rows for side-by-side display, where a or b is null
// if that side has no matching line, and the number of rows that differ.
function diffLines(aText, bText) {
  const a = aText.split(/\r?\n/);
  const b = bText.split(/\r?\n/);

  // Most edits are local, so skip the lines shared at both ends.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }

  const n = endA - start;
  const m = endB - start;
  const tooLarge = n * m > DIFF_MAX_CELLS;

  // lcs[i * (m + 1) + j]: longest common subsequence of the lines from i and j onward.
  let lcs = null;
  if (n && m && !tooLarge) {
    lcs = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        const here = i * (m + 1) + j;
        lcs[here] = a[start + i] === b[start + j]
          ? lcs[here + m + 2] + 1
          : Math.max(lcs[here + m + 1], lcs[here + 1]);
      }
    }
  }

  const rows = [];
  let aNo = 1;
  let bNo = 1;
  let removed = [];
  let added = [];
  const same = (line) => rows.push({ a: line, b: line, aNo: aNo++, bNo: bNo++, same: true });
  // A run of changes: removed and added lines sit side by side, in order.
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const hasA = k < removed.length;
      const hasB = k < added.length;
      rows.push({
        a: hasA ? removed[k] : null,
        b: hasB ? added[k] : null,
        aNo: hasA ? aNo++ : null,
        bNo: hasB ? bNo++ : null,
        same: false,
      });
    }
    removed = [];
    added = [];
  };

  for (let k = 0; k < start; k++) same(a[k]);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (lcs && i < n && j < m && a[start + i] === b[start + j]) {
      flush();
      same(a[start + i]);
      i++;
      j++;
    } else if (i < n && (j === m || !lcs || lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1])) {
      removed.push(a[start + i++]);
    } else {
      added.push(b[start + j++]);
    }
  }
  flush();
  for (let k = endA; k < a.length; k++) same(a[k]);

  return { rows, changed: rows.filter((r) => !r.same).length, tooLarge };
}

// The part of a line that differs from another: everything between their common start and end.
function changedRange(text, other) {
  let start = 0;
  while (start < text.length && start < other.length && text[start] === other[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(text[start - 1])) start--; // don't split an emoji
  let tail = 0;
  while (tail < text.length - start && tail < other.length - start
    && text[text.length - 1 - tail] === other[other.length - 1 - tail]) tail++;
  if (tail > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - tail])) tail--;
  return [start, text.length - tail];
}
