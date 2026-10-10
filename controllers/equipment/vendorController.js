// Vendors (companies or individuals renting machines to us) and their rental contracts.
const { pool, withTransaction } = require('../../config/db');
const AppError = require('../../utils/AppError');
const { v, validate, parseId } = require('../../utils/validate');
const audit = require('../../services/audit');
const storage = require('../../services/fileStorage');
const uploads = require('../../services/uploads');
const settings = require('../../services/settings');
const { businessToday } = require('../../utils/businessDate');
const C = require('../../services/equipment/eqCommon');
const FV = require('../../services/equipment/eqFileVersions');

const VENDOR_FIELDS = {
  vendor_name: v.string({ max: 255 }),
  // 015: a person with one machine and no company is an Individual (national ID instead of tax number)
  vendor_type: v.enumOf(['Company', 'Individual']),
  contact_person: v.string({ max: 255 }),
  phone_number: v.string({ max: 50 }),
  email: v.string({ max: 255, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, patternMessage: 'must be a valid email' }),
  address: v.string({ max: 500 }),
  tax_number: v.string({ max: 100 }),
  national_id: v.string({ max: 100 }),
  notes: v.string({ max: 5000 }),
};

exports.list = async (req, res) => {
  const where = []; const params = [];
  if (req.query.status) { where.push('v.status = ?'); params.push(String(req.query.status)); }
  if (req.query.q) { where.push('(v.vendor_name LIKE ? OR v.vendor_code LIKE ?)'); params.push(`%${req.query.q}%`, `%${req.query.q}%`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  if (req.user.role === 'Supervisor') {
    const [rows] = await pool.query(`SELECT v.vendor_id, v.vendor_code, v.vendor_name, v.status FROM eq_vendors v ${w} ORDER BY v.vendor_name`, params);
    return res.json({ status: 'success', data: rows });
  }
  const today = businessToday();
  const [rows] = await pool.query(
    `SELECT v.*,
       (SELECT COUNT(*) FROM eq_equipment e WHERE e.vendor_id = v.vendor_id) AS machines,
       (SELECT COUNT(DISTINCT e.equipment_id) FROM eq_equipment e JOIN eq_site_assignments a ON a.equipment_id = e.equipment_id
         WHERE e.vendor_id = v.vendor_id AND a.assigned_date <= ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)) AS deployed_now,
       (SELECT COUNT(*) FROM eq_vendor_contracts c WHERE c.vendor_id = v.vendor_id AND c.status = 'Active') AS active_contracts
     FROM eq_vendors v ${w} ORDER BY v.status, v.vendor_name`, [today, today, ...params]);
  return res.json({ status: 'success', data: rows });
};

exports.create = async (req, res) => {
  const data = validate(req.body, { ...VENDOR_FIELDS, vendor_name: v.string({ required: true, max: 255 }) });
  const vendor = await withTransaction(async (conn) => {
    const code = await C.nextCode(conn, 'eq_vendors', 'vendor_code', 'VND-', 3);
    const [r] = await conn.execute(
      `INSERT INTO eq_vendors (vendor_code, vendor_name, vendor_type, contact_person, phone_number, email, address, tax_number, national_id, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [code, data.vendor_name, data.vendor_type || 'Company', data.contact_person || null, data.phone_number || null, data.email || null,
        data.address || null, data.tax_number || null, data.national_id || null, data.notes || null, req.user.user_id]);
    const created = await C.loadVendor(conn, r.insertId);
    await audit.log(conn, { table: 'eq_vendors', id: r.insertId, action: 'create', newValues: created, ...audit.ctx(req) });
    return created;
  });
  res.status(201).json({ status: 'success', data: vendor });
};

exports.get = async (req, res) => {
  const id = parseId(req.params.id);
  const vendor = await C.loadVendor(pool, id);
  const [contracts] = await pool.execute('SELECT * FROM eq_vendor_contracts WHERE vendor_id = ? ORDER BY start_date DESC', [id]);
  const [machines] = await pool.execute(
    `SELECT e.equipment_id, e.equipment_code, e.machine_label, e.type_seq, e.plate_number, e.status, t.type_name FROM eq_equipment e
     JOIN eq_types t ON t.type_id = e.type_id WHERE e.vendor_id = ? ORDER BY t.type_name, e.type_seq, e.equipment_code`, [id]);
  const [operators] = await pool.execute('SELECT * FROM eq_operators WHERE vendor_id = ? ORDER BY full_name', [id]);
  res.json({ status: 'success', data: { ...vendor, contracts, machines, operators } });
};

exports.update = async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(req.body, VENDOR_FIELDS);
  const vendor = await withTransaction(async (conn) => {
    const before = await C.loadVendor(conn, id, true);
    const keys = Object.keys(data);
    if (keys.length) {
      await conn.execute(`UPDATE eq_vendors SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE vendor_id = ?`, [...keys.map((k) => data[k]), id]);
    }
    const after = await C.loadVendor(conn, id);
    await audit.log(conn, { table: 'eq_vendors', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: vendor });
};

exports.setStatus = async (req, res) => {
  const id = parseId(req.params.id);
  const { status, reason } = validate(req.body, { status: v.enumOf(['Active', 'Inactive'], { required: true }), reason: v.string({ max: 500 }) });
  const vendor = await withTransaction(async (conn) => {
    const before = await C.loadVendor(conn, id, true);
    if (status === 'Inactive') {
      const today = businessToday();
      const [dep] = await conn.execute(
        `SELECT e.equipment_code FROM eq_equipment e JOIN eq_site_assignments a ON a.equipment_id = e.equipment_id
         WHERE e.vendor_id = ? AND (a.unassigned_date IS NULL OR a.unassigned_date >= ?)`, [id, today]);
      if (dep.length) throw AppError.conflict('VENDOR_HAS_DEPLOYED_MACHINES', 'End the deployments of this vendor\'s machines first.', { machines: dep.map((d) => d.equipment_code) });
    }
    await conn.execute('UPDATE eq_vendors SET status = ? WHERE vendor_id = ?', [status, id]);
    await audit.log(conn, { table: 'eq_vendors', id, action: 'status', oldValues: { status: before.status }, newValues: { status }, reason: reason || null, ...audit.ctx(req) });
    return C.loadVendor(conn, id);
  });
  res.json({ status: 'success', data: vendor });
};

// ------------------------------------------------------------------ contracts
const CONTRACT_FIELDS = {
  contract_number: v.string({ max: 100 }),
  start_date: v.date(),
  end_date: v.date(),
  currency: v.currency(),
  payment_terms: v.string({ max: 255 }),
  status: v.enumOf(['Draft', 'Active', 'Expired', 'Terminated']),
  notes: v.string({ max: 5000 }),
};

exports.listContracts = async (req, res) => {
  const id = parseId(req.params.id);
  await C.loadVendor(pool, id);
  const [rows] = await pool.execute(
    `SELECT c.*, (SELECT COUNT(*) FROM eq_rate_cards rc WHERE rc.vendor_contract_id = c.vendor_contract_id) AS rate_cards
     FROM eq_vendor_contracts c WHERE c.vendor_id = ? ORDER BY c.start_date DESC`, [id]);
  res.json({ status: 'success', data: rows.map(({ document_path, ...r }) => ({ ...r, has_document: Boolean(document_path) })) });
};

exports.createContract = async (req, res) => {
  const vendorId = parseId(req.params.id);
  const data = validate(req.body, {
    ...CONTRACT_FIELDS,
    contract_number: v.string({ required: true, max: 100 }),
    start_date: v.date({ required: true }),
  });
  if (data.end_date && data.end_date < data.start_date) throw AppError.validation({ end_date: 'must be on or after start_date' });
  const currency = data.currency || await settings.getString('eq_default_currency');
  const contract = await withTransaction(async (conn) => {
    await C.loadVendor(conn, vendorId, true);
    const [r] = await conn.execute(
      `INSERT INTO eq_vendor_contracts (vendor_id, contract_number, start_date, end_date, currency, payment_terms, status, notes, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vendorId, data.contract_number, data.start_date, data.end_date || null, currency, data.payment_terms || null,
        data.status || 'Active', data.notes || null, req.user.user_id]);
    const created = await C.loadContract(conn, r.insertId);
    await audit.log(conn, { table: 'eq_vendor_contracts', id: r.insertId, action: 'create', newValues: created, ...audit.ctx(req) });
    return created;
  });
  res.status(201).json({ status: 'success', data: contract });
};

exports.updateContract = async (req, res) => {
  const id = parseId(req.params.id);
  const data = validate(req.body, CONTRACT_FIELDS);
  const contract = await withTransaction(async (conn) => {
    const before = await C.loadContract(conn, id, true);
    const next = { ...before, ...data };
    if (next.end_date && next.end_date < next.start_date) throw AppError.validation({ end_date: 'must be on or after start_date' });
    const [cards] = await conn.execute('SELECT rate_card_id, effective_from, effective_to FROM eq_rate_cards WHERE vendor_contract_id = ?', [id]);
    const outside = cards.filter((c) => c.effective_from < next.start_date
      || (next.end_date && (!c.effective_to || c.effective_to > next.end_date)));
    if (outside.length) throw AppError.conflict('CONTRACT_DATES_EXCLUDE_RATE_CARDS', 'The new dates would leave rate cards outside the contract.', { rate_cards: outside });
    if (data.currency && data.currency !== before.currency && cards.length) {
      throw AppError.conflict('CONTRACT_CURRENCY_LOCKED', 'The currency cannot change once rate cards exist.');
    }
    const keys = Object.keys(data);
    if (keys.length) await conn.execute(`UPDATE eq_vendor_contracts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE vendor_contract_id = ?`, [...keys.map((k) => data[k]), id]);
    const after = await C.loadContract(conn, id);
    await audit.log(conn, { table: 'eq_vendor_contracts', id, action: 'update', oldValues: before, newValues: after, ...audit.ctx(req) });
    return after;
  });
  res.json({ status: 'success', data: contract });
};

exports.uploadDocument = [uploads.single('file'), async (req, res) => {
  const id = parseId(req.params.id);
  const type = uploads.detect(req.file.buffer, ['pdf', 'jpg', 'png']);
  const hash = storage.sha256(req.file.buffer);
  const key = `equipment/contracts/${id}/${hash.slice(0, 16)}.${type.ext}`;
  const contract = await withTransaction(async (conn) => {
    const before = await C.loadContract(conn, id, true);
    const v = await FV.add(conn, {
      ownerTable: 'eq_vendor_contracts', ownerId: id, key, sha256: hash, contentType: type.mime, size: req.file.size || req.file.buffer.length,
      originalName: req.file.originalname, reason: req.body && req.body.reason, userId: req.user.user_id,
    });
    await storage.put({ key, buffer: req.file.buffer, contentType: type.mime });
    await conn.execute('UPDATE eq_vendor_contracts SET document_path = ?, document_sha256 = ? WHERE vendor_contract_id = ?', [key, hash, id]);
    await audit.log(conn, { table: 'eq_vendor_contracts', id, action: v.replaced_version ? 'replace_document' : 'upload_document', oldValues: { document_path: before.document_path },
      newValues: { document_path: key, sha256: hash, version_no: v.version_no }, reason: (req.body && req.body.reason) || null, ...audit.ctx(req) });
    return C.loadContract(conn, id);
  });
  res.status(201).json({ status: 'success', data: contract });
}];

exports.listDocuments = async (req, res) => {
  const id = parseId(req.params.id);
  await C.loadContract(pool, id);
  res.json({ status: 'success', data: await FV.list(pool, 'eq_vendor_contracts', id) });
};

exports.downloadDocument = async (req, res) => {
  const id = parseId(req.params.id);
  const c = await C.loadContract(pool, id);
  const version = req.query.version ? parseId(req.query.version) : null;
  const fv = await FV.get(pool, 'eq_vendor_contracts', id, version);
  const key = fv ? fv.storage_key : (version ? null : c.document_path);
  if (!key) throw AppError.notFound('Contract document');
  const ext = FV.extOf(key);
  const mime = { pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' }[ext] || 'application/octet-stream';
  await storage.send(res, key, { contentType: mime, fileName: `contract-${c.contract_number}${fv ? `-v${fv.version_no}` : ''}.${ext}` });
};
