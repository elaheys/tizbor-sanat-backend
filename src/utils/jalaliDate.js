const jalaali = require('jalaali-js');

// Converts a Jalali (year, month) into the Gregorian date-string range that spans it —
// [start, end) where `end` is exclusive (the first day of the next Jalali month). Dates
// are returned as plain "YYYY-MM-DD" strings (not Date objects) so Postgres parses them
// using its own session timezone, the same way the existing `from`/`to` filters already do
// — avoids introducing a second, possibly-mismatched timezone assumption in JS.
function jalaliMonthRange(jYear, jMonth) {
  const pad = (n) => String(n).padStart(2, '0');
  const toDateString = ({ gy, gm, gd }) => `${gy}-${pad(gm)}-${pad(gd)}`;

  const start = jalaali.toGregorian(jYear, jMonth, 1);

  const nextJYear = jMonth === 12 ? jYear + 1 : jYear;
  const nextJMonth = jMonth === 12 ? 1 : jMonth + 1;
  const end = jalaali.toGregorian(nextJYear, nextJMonth, 1);

  return { start: toDateString(start), end: toDateString(end) };
}

// Last calendar day of a Jalali month, as a "YYYY-MM-DD" Gregorian date string — used to
// look up a partner's share-percent "as it stood at the end of this month".
function jalaliMonthEndDate(jYear, jMonth) {
  const pad = (n) => String(n).padStart(2, '0');
  const lastDay = jalaali.jalaaliMonthLength(jYear, jMonth);
  const g = jalaali.toGregorian(jYear, jMonth, lastDay);
  return `${g.gy}-${pad(g.gm)}-${pad(g.gd)}`;
}

module.exports = { jalaliMonthRange, jalaliMonthEndDate };
