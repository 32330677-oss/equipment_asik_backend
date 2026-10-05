// utils/money.js — money is handled as integer cents in calculations.
function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  return Math.round(Number(value) * 100);
}
function fromCents(cents) { return Math.round(cents) / 100; }
function toDecimalString(cents) { return (Math.round(cents) / 100).toFixed(2); }

function formatMoney(cents, currency = 'USD') {
  const v = Math.round(cents) / 100;
  if (currency === 'SYP') return `SYP ${Math.round(v).toLocaleString('en-US')}`;
  return `${currency} ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

module.exports = { toCents, fromCents, toDecimalString, formatMoney };
