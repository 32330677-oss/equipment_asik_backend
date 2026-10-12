// controllers/helpController.js — the Help Center (no AI, no key, nothing to pay): content from assistant/guide.md,
// filtered by the caller's role on the server.
const help = require('../services/help');
const AppError = require('../utils/AppError');

const screenParam = (req) => (typeof req.query.screen === 'string' && /^[a-z0-9-]{1,60}$/.test(req.query.screen) ? req.query.screen : null);

function guideOr503(fn) {
  try {
    return fn();
  } catch (e) {
    if (e && e.code === 'ENOENT') throw new AppError(503, 'HELP_UNAVAILABLE', 'The help content is not installed on the server (assistant/guide.md).');
    throw e;
  }
}

/** GET /api/help?screen=<id> — on this page, popular for the role, all topics, the screens the role has. */
exports.home = async (req, res) => {
  res.json({ status: 'success', data: guideOr503(() => help.home(req.user.role, screenParam(req))) });
};

/** GET /api/help/search?q=<words>&screen=<id> */
exports.search = async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 200) : '';
  res.json({ status: 'success', data: guideOr503(() => help.find(req.user.role, q, screenParam(req))) });
};

/** GET /api/help/topics/:id — 404 also when the role may not see it (nothing tells that it exists). */
exports.topic = async (req, res) => {
  const id = String(req.params.id || '');
  const t = /^[a-z0-9-]{1,80}$/.test(id) ? guideOr503(() => help.topic(req.user.role, id)) : null;
  if (!t) throw AppError.notFound('Help topic');
  res.json({ status: 'success', data: t });
};
