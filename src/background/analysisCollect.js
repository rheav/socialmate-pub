// Instagram's "Comentários de todos" sweep: each listed post is opened in a tab
// of our own and the bridge reads its whole comment thread.
//
// Instagram is touched the way the Spy touches it: one background tab, one post
// at a time, 20–40 s apart, never while a Spy batch is running, and a login wall
// or a rate limit seen on this tab pauses Instagram for the Spy too (the same
// 12-hour pause). None of it counts as a daily Spy reading.
//
// What could not be collected is reported as missing, never guessed: a page that
// shows another post contributes nothing, an expired video link gets one fresh
// look, a video past the limits is reported too large. The job's state is
// persisted so a worker restart closes the tab it left behind.

import { IG_COMMENT_EXPAND_LIMITS } from "../lib/shared/igCommentExpand.js";

export const ANALYSIS_COLLECT_KEY = "fbw_analysis_collect"; // { taskId, tabId, code, startedAt, nextAt }
export const ANALYSIS_MARKER = "#socialmate-analysis";

export const COLLECT_LIMITS = {
  maxBytes: 100 * 1024 * 1024,
  maxDurationS: 600,
  gapMs: [20_000, 40_000],
  busyWaitMs: 6 * 60_000,
  busyPollMs: 15_000,
  readyMs: 20_000,
  downloadMs: 5 * 60_000,
  /** Posts per comment sweep. */
  sweepMax: 15,
};

const CODE_RE = /^[A-Za-z0-9_-]{1,40}$/;
const LOGIN_WALL = /instagram\.com\/(accounts\/login|challenge|checkpoint)/;

const idle = (nextAt = 0) => ({ taskId: null, tabId: null, code: null, startedAt: null, nextAt });

/**
 * @param {object} deps
 * @param {object} deps.chrome  tabs + storage.local
 * @param {() => Promise<{url,token}|null>} [deps.hub]  the Acervo the extension syncs to (private build)
 * @param {{ blocked(): Promise<string|null>, busy(): Promise<boolean>, pause(code): Promise<void>, serialize(work): Promise }} deps.instagram
 *   the Spy's shared Instagram state (see background/spy.js)
 * @param {(req) => Promise<{status,text?,chunks?,language?,source?}|null>} [deps.transcribe]  the extension's Whisper job (private build)
 */
export function createAnalysisCollect({
  chrome,
  fetchImpl = fetch,
  instagram,
  now = Date.now,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  random = Math.random,
  limits = {},
}) {
  const L = { ...COLLECT_LIMITS, ...limits };
  // Jobs in flight: a Hub job, or one post of a comment sweep. Their tab phases
  // never overlap (instagram.serialize); a sweep also yields to Hub jobs.
  const jobs = new Set(); // { taskId, tabId, code, stop, cancelled, sweep? }
  let sweep = null; // { running, total, done, current, stopReason, cancel }

  async function load() {
    const r = await chrome.storage.local.get(ANALYSIS_COLLECT_KEY);
    return { ...idle(), ...(r[ANALYSIS_COLLECT_KEY] || {}) };
  }
  async function save(patch) {
    const next = { ...(await load()), ...patch };
    await chrome.storage.local.set({ [ANALYSIS_COLLECT_KEY]: next });
    return next;
  }

  /** Close a tab only if it is still ours: our marker, a login wall, or our post never shown to the user. */
  async function closeOwnTab(tabId, code) {
    if (tabId == null) return;
    try {
      const tab = await chrome.tabs.get(tabId);
      const url = tab?.url || "";
      let ourPost = false;
      try {
        const u = new URL(url);
        ourPost = !!code && !tab.active && /(^|\.)instagram\.com$/.test(u.hostname) && new RegExp(`^/(p|reel|reels)/${code}/`).test(u.pathname);
      } catch {
        /* not a URL */
      }
      if (url.endsWith(ANALYSIS_MARKER) || LOGIN_WALL.test(url) || ourPost) await chrome.tabs.remove(tabId);
    } catch {
      /* already closed */
    }
  }

  /** Sleep in steps, so a cancel is noticed within a few seconds. */
  async function wait(ms, job) {
    const end = now() + ms;
    while (!job.cancelled && now() < end) await sleep(Math.min(5_000, end - now()));
  }

  async function ask(tabId, msg) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg);
    } catch {
      return null;
    }
  }

  async function whenReady(job) {
    const end = now() + L.readyMs;
    while (now() < end && !job.cancelled && !job.stop) {
      const pong = await ask(job.tabId, { type: "FBW_PING" });
      if (pong?.ok) return true;
      await sleep(1_000);
    }
    return false;
  }

  /** The page's answer for this post, or null when the page could not say. */
  async function readPage(job, p, comments) {
    job.live?.({ phase: "opening" });
    if (!(await whenReady(job))) return null;
    if (comments) job.live?.({ phase: "comments", detail: "até 200 comentários, 20 cliques ou 90 s" });
    const res = await ask(job.tabId, {
      type: "FBW_ANALYSIS_COLLECT",
      code: job.code,
      mediaPk: p.mediaPk || null,
      comments,
      limits: IG_COMMENT_EXPAND_LIMITS,
    });
    return res?.ok ? res : null;
  }


  /** The Instagram part: own tab, page read, video bytes. Closed whatever happens. */
  async function collectInTab(job, p) {
    const tab = await chrome.tabs.create({ url: `https://www.instagram.com/p/${job.code}/${ANALYSIS_MARKER}`, active: false });
    job.tabId = tab.id;
    await save({ taskId: job.taskId, tabId: tab.id, code: job.code, startedAt: now() });
    try {
      // Only the comment sweep asks for the thread; the Hub's jobs never do.
      const page = await readPage(job, p, !!p.needs?.comments);
      if (job.cancelled || job.stop || !page) return { page };
      return { page };
    } finally {
      await closeOwnTab(job.tabId, job.code);
      await save({ taskId: null, tabId: null, code: null, startedAt: null });
    }
  }


  /**
   * Before opening Instagram: not while it is paused, not during a Spy batch
   * (waits up to six minutes), and 20–40 s after the previous post. → null to
   * go ahead, or why not.
   */
  async function gate(job) {
    if (await instagram.blocked()) return "instagram_paused";
    const waitUntil = now() + L.busyWaitMs;
    while (await instagram.busy()) {
      if (job.cancelled) return "cancelled";
      if (now() >= waitUntil) return "instagram_busy";
      job.live?.({ phase: "waiting_spy" });
      await wait(L.busyPollMs, job);
    }
    const { nextAt } = await load();
    if (nextAt > now()) {
      job.live?.({ phase: "waiting_gap", detail: `${Math.round((nextAt - now()) / 1000)} s` });
      await wait(nextAt - now(), job);
    }
    return job.cancelled ? "cancelled" : null;
  }

  async function spaceNext() {
    const gap = L.gapMs[0] + Math.round(random() * (L.gapMs[1] - L.gapMs[0]));
    await save({ nextAt: now() + gap });
  }


  /**
   * Open each listed post in a tab of our own and read its whole comment thread
   * under the usual budget — the old bridge's "collect the profile's comments".
   * The comments flow out the way every capture does (panel, Instagram Scraper
   * destinations). One sweep at a time, at most `sweepMax` posts, 20–40 s
   * apart, yielding to Hub jobs; a login wall or rate limit stops it and pauses
   * Instagram for the Spy too. → { ok, done, total, stopReason }
   */
  async function sweepComments(codes) {
    if (sweep?.running) return { ok: false, code: "busy" };
    const list = [...new Set((Array.isArray(codes) ? codes : []).filter((c) => typeof c === "string" && CODE_RE.test(c)))].slice(0, L.sweepMax);
    const run = { running: true, total: list.length, done: 0, current: null, stopReason: null, cancel: false };
    sweep = run;
    try {
      for (const code of list) {
        if (run.cancel) {
          run.stopReason = "cancelled";
          break;
        }
        // A Hub job comes first: wait for it between posts.
        while ([...jobs].some((j) => !j.sweep)) await sleep(5_000);
        const job = { taskId: `sweep:${code}`, code, tabId: null, stop: null, cancelled: false, sweep: true };
        jobs.add(job);
        run.current = code;
        try {
          const blocked = await gate(job);
          if (blocked) {
            run.stopReason = blocked;
            break;
          }
          await instagram.serialize(() => collectInTab(job, { needs: { comments: true }, mediaPk: null }));
          await spaceNext();
        } finally {
          jobs.delete(job);
        }
        if (job.stop) {
          await instagram.pause(job.stop);
          run.stopReason = job.stop;
          break;
        }
        run.done += 1;
      }
      return { ok: true, done: run.done, total: run.total, stopReason: run.stopReason };
    } finally {
      run.running = false;
      run.current = null;
    }
  }

  function stopSweep() {
    if (!sweep?.running) return false;
    sweep.cancel = true;
    for (const j of jobs) if (j.sweep) j.cancelled = true;
    return true;
  }


  /** On worker start: a job in flight died with the old worker. Close its tab, forget it. */
  async function recover() {
    const state = await load();
    if (!state.taskId && state.tabId == null) return;
    await closeOwnTab(state.tabId, state.code);
    await save({ ...idle(state.nextAt) });
  }

  /** Responses on Instagram (webRequest): 401/403 → login, 429 → rate limit, on our tab only. */
  function onResponse({ tabId, statusCode, url }) {
    const job = [...jobs].find((j) => j.tabId != null && j.tabId === tabId);
    if (!job || ![401, 403, 429].includes(statusCode)) return;
    try {
      if (!/(^|\.)instagram\.com$/.test(new URL(url).hostname)) return;
    } catch {
      return;
    }
    job.stop = job.stop || (statusCode === 429 ? "rate_limited" : "login_required");
  }

  /** Navigations of our tab: a login wall or a challenge stops the job. */
  function onNavigation(tabId, url) {
    const job = [...jobs].find((j) => j.tabId != null && j.tabId === tabId);
    if (job && LOGIN_WALL.test(url || "")) job.stop = job.stop || "login_required";
  }

  return {
    recover,
    onResponse,
    onNavigation,
    sweepComments,
    stopSweep,
    sweepStatus: () => (sweep ? { running: sweep.running, total: sweep.total, done: sweep.done, current: sweep.current, stopReason: sweep.stopReason } : null),
    status: () => [...jobs].map((j) => ({ taskId: j.taskId })),
  };
}
