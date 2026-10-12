// services/help/index.js — the Help Center as one role sees it. The filtering happens here, on the server:
// a supervisor never receives an Admin topic or an office screen, not even in "related" or in search results.
const { loadGuide } = require('./guide');
const { indexTopics, search } = require('./search');

let indexCache = null; // { version, index }

function guideIndex(guide) {
  if (!indexCache || indexCache.version !== guide.version) indexCache = { version: guide.version, index: indexTopics(guide.topics) };
  return indexCache.index;
}

/** Everything one role may see of the current guide. */
function viewFor(role) {
  const guide = loadGuide();
  const screens = guide.screens.filter((s) => s.roles.includes(role));
  const screenById = new Map(screens.map((s) => [s.id, s]));
  const visible = new Set(guide.topics.filter((t) => t.roles.includes(role)).map((t) => t.id));
  const topics = guide.topics.filter((t) => visible.has(t.id));
  return { guide, role, screens, screenById, visible, topics, index: guideIndex(guide).filter((i) => visible.has(i.topic.id)) };
}

function summaryOf(view, t) {
  const open = t.open && view.screenById.get(t.open);
  return {
    id: t.id,
    title: t.title,
    summary: t.summary,
    screens: t.screens.filter((s) => view.screenById.has(s)),
    open: open ? { id: open.id, title: open.title } : null,
  };
}

/** Home of the Help Center: "On this page" (topics of the screen the user came from), popular, all. */
function home(role, screen) {
  const view = viewFor(role);
  const here = screen && view.screenById.has(screen) ? screen : null;
  return {
    version: view.guide.version,
    role,
    screen: here ? view.screenById.get(here) : null,
    screens: view.screens.map((s) => ({ id: s.id, title: s.title })),
    on_this_page: here ? view.topics.filter((t) => t.screens.includes(here)).map((t) => summaryOf(view, t)) : [],
    popular: view.topics.filter((t) => t.popular.includes(role)).map((t) => summaryOf(view, t)),
    topics: view.topics.map((t) => summaryOf(view, t)),
  };
}

/** One topic, or null when it does not exist or the role may not see it (same answer: nothing leaks). */
function topic(role, id) {
  const view = viewFor(role);
  const t = view.topics.find((x) => x.id === id);
  if (!t) return null;
  return {
    ...summaryOf(view, t),
    version: view.guide.version,
    blocks: t.blocks,
    related: t.related.filter((r) => view.visible.has(r)).map((r) => summaryOf(view, view.topics.find((x) => x.id === r))),
  };
}

function find(role, q, screen) {
  const view = viewFor(role);
  const here = screen && view.screenById.has(screen) ? screen : null;
  const out = search(view.index, q, { screen: here });
  return { query: String(q || ''), exact: out.exact, results: out.results.map((r) => ({ ...summaryOf(view, r.topic), score: r.score })) };
}

module.exports = { home, topic, find, viewFor };
