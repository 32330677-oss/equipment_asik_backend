// services/help/guide.js — reads assistant/guide.md (the Help Center content) and turns it into screens + topics.
// The file is re-read when it changes on disk, so editing it updates every user without an app release or a restart.
const fs = require('fs');
const path = require('path');

const ROLES = ['Admin', 'Accountant', 'Supervisor'];
const DEFAULT_PATH = path.join(__dirname, '..', '..', 'assistant', 'guide.md');

function guidePath() {
  return process.env.HELP_GUIDE_PATH || DEFAULT_PATH;
}

const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const roleList = (v) => list(v).map((r) => ROLES.find((x) => x.toLowerCase() === r.toLowerCase())).filter(Boolean);

/** Body text -> blocks the app renders: step (numbered), bullet, note (box), p (paragraph). Bold stays as **x**. */
function parseBlocks(lines) {
  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
  };
  let n = 0;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const t = line.trim();
    if (!t) { flush(); continue; }
    let m;
    if ((m = /^(\d+)[.)]\s+(.*)$/.exec(t)) && !/^\s/.test(line)) {
      flush();
      n = Number(m[1]);
      blocks.push({ type: 'step', n, text: m[2] });
    } else if ((m = /^[-*]\s+(.*)$/.exec(t))) {
      flush();
      // an indented bullet under a step belongs to that step
      blocks.push({ type: 'bullet', text: m[1], ...(/^\s/.test(line) && blocks.length && blocks[blocks.length - 1].type !== 'p' ? { nested: true } : {}) });
    } else if ((m = /^(Tip|Note|Warning):\s*(.*)$/i.exec(t))) {
      flush();
      blocks.push({ type: 'note', kind: m[1].toLowerCase(), text: m[2] });
    } else {
      para.push(t);
    }
  }
  flush();
  return blocks;
}

/** Plain text of a markdown-ish string (for search). */
const plain = (s) => String(s || '').replace(/\*\*/g, '').replace(/[`_]/g, '');

function parseGuide(text) {
  const warnings = [];
  const screens = [];
  const topics = [];
  const lines = String(text).replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n');

  let cur = null;
  const finish = () => {
    if (!cur) return;
    const { meta, body } = cur;
    const id = (meta.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { warnings.push(`Topic "${cur.title}" has no valid id: skipped`); cur = null; return; }
    const blocks = parseBlocks(body);
    const firstP = blocks.findIndex((b) => b.type === 'p');
    const summary = firstP === 0 ? blocks[0].text : '';
    const roles = roleList(meta.roles);
    if (!roles.length) warnings.push(`Topic ${id}: no roles, nobody will see it`);
    if (!summary) warnings.push(`Topic ${id}: no summary (the first paragraph, before the steps)`);
    topics.push({
      id,
      title: cur.title,
      roles,
      screens: list(meta.screens || meta.screen),
      open: (meta.open || '').trim() || null,
      popular: roleList(meta.popular),
      keywords: plain(meta.keywords || ''),
      related: list(meta.related),
      summary,
      blocks: firstP === 0 ? blocks.slice(1) : blocks,
    });
    cur = null;
  };

  for (const line of lines) {
    let m;
    if ((m = /^##\s+(.+?)\s*$/.exec(line))) {
      finish();
      cur = { title: m[1], meta: {}, body: [], inMeta: true };
      continue;
    }
    if (!cur) {
      if ((m = /^@screen\s+(.+)$/.exec(line.trim()))) {
        const [id, title, roles] = m[1].split('|').map((s) => s.trim());
        if (id && title) screens.push({ id, title, roles: roleList(roles) });
        else warnings.push(`Bad screen line: ${line.trim()}`);
      }
      continue;
    }
    if (cur.inMeta) {
      if ((m = /^([a-z_]+):\s*(.*)$/i.exec(line.trim())) && line.trim()) {
        cur.meta[m[1].toLowerCase()] = m[2];
        continue;
      }
      if (!line.trim()) { cur.inMeta = false; continue; }
      cur.inMeta = false;
    }
    cur.body.push(line);
  }
  finish();

  // checks: duplicates, unknown screens and related ids (reported, never fatal)
  const ids = new Set();
  const screenIds = new Set(screens.map((s) => s.id));
  for (const t of topics) {
    if (ids.has(t.id)) warnings.push(`Duplicate topic id ${t.id}`);
    ids.add(t.id);
  }
  for (const t of topics) {
    for (const s of t.screens) if (!screenIds.has(s)) warnings.push(`Topic ${t.id}: unknown screen ${s}`);
    if (t.open && !screenIds.has(t.open)) warnings.push(`Topic ${t.id}: unknown open screen ${t.open}`);
    for (const r of t.related) if (!ids.has(r)) warnings.push(`Topic ${t.id}: unknown related topic ${r}`);
  }
  return { screens, topics, warnings };
}

let cache = null; // { key, guide }

/** The current guide; re-parsed only when the file changed. Throws ENOENT when the file is missing. */
function loadGuide() {
  const file = guidePath();
  const st = fs.statSync(file);
  const key = `${file}:${st.mtimeMs}:${st.size}`;
  if (cache && cache.key === key) return cache.guide;
  const guide = parseGuide(fs.readFileSync(file, 'utf8'));
  guide.version = `${Math.round(st.mtimeMs)}-${st.size}`;
  if (guide.warnings.length && process.env.NODE_ENV !== 'test') {
    console.warn(`[help] ${file}:\n - ${guide.warnings.join('\n - ')}`);
  }
  cache = { key, guide };
  return guide;
}

function clearCache() { cache = null; }

module.exports = { ROLES, parseGuide, parseBlocks, loadGuide, clearCache, guidePath, plain };
