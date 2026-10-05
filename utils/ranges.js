// utils/ranges.js — inclusive date ranges; a NULL/undefined end means "open".
const OPEN_END = '9999-12-31';

function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  const aEnd = aTo || OPEN_END;
  const bEnd = bTo || OPEN_END;
  return aFrom <= bEnd && bFrom <= aEnd;
}

function covers(from, to, date) {
  return from <= date && (!to || to >= date);
}

/** SQL predicate: row alias covers the date expression (2 placeholders when dateExpr = '?'). */
function activeOnSql(alias, fromCol, toCol, dateExpr = '?') {
  const a = alias ? `${alias}.` : '';
  return `(${a}${fromCol} <= ${dateExpr} AND (${a}${toCol} IS NULL OR ${a}${toCol} >= ${dateExpr}))`;
}

/** SQL predicate: row range overlaps a new range. 2 placeholders, in this order: newTo (may be NULL = open), newFrom. */
function overlapsSql(alias, fromCol, toCol) {
  const a = alias ? `${alias}.` : '';
  return `(${a}${fromCol} <= COALESCE(?, '${OPEN_END}') AND COALESCE(${a}${toCol}, '${OPEN_END}') >= ?)`;
}

module.exports = { OPEN_END, rangesOverlap, covers, activeOnSql, overlapsSql };
