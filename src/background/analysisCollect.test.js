import { describe, it, expect } from "vitest";
import { ANALYSIS_COLLECT_KEY, ANALYSIS_MARKER, createAnalysisCollect } from "./analysisCollect.js";
const CDN = (name) => `https://scontent.cdninstagram.com/v/${name}.mp4?oe=1`;
const MiB = 1024 * 1024;

/** A tiny well-formed MP4: size, 'ftyp', brand. */
function mp4(bytes = 64) {
  const b = new Uint8Array(bytes);
  b.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
  return b;
}

function stream(chunks, { status = 200, length = null } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-length" && length != null ? String(length) : null) },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }), cancel: async () => {} }) },
    json: async () => ({}),
  };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body });
const html = (status, text) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text });
/** The post's embed page, shaped as measured on 2026-10-22 (the post is a JSON string in a script). */
const embedPage = (media) =>
  `<script>{"contextJSON":${JSON.stringify(JSON.stringify({ context: { shortcode: media.shortcode }, gql_data: { shortcode_media: media } }).replace(/\//g, "\\/"))}}</script>`;

const job = (over = {}) => ({
  taskId: "t1",
  leaseToken: "lease-1",
  payload: {
    postKey: "instagram:3003",
    mediaPk: "3003",
    code: "CCC",
    sourceUrl: "https://www.instagram.com/reel/CCC/",
    reportedComments: 3,
    assetId: "a1",
    reuseAssetId: null,
    needs: { video: true, captionFull: true, transcript: true },
    ...over,
  },
});

const pageAnswer = (over = {}) => ({
  ok: true,
  code: "CCC",
  pk: "3003",
  url: "https://www.instagram.com/p/CCC/",
  caption: { text: "legenda inteira", full: true },
  variants: [{ w: 1080, h: 1920, url: CDN("1080") }, { w: 720, h: 1280, url: CDN("720") }],
  durationS: 41,
  mediaType: "video",
  authors: ["nasa", "partner"],
  comments: {
    items: [
      { cid: "9001", text: "que bom", username: "fa", digg_count: 2, create_time: 1, parent: null },
      { cid: "9002", text: "obrigada", username: "nasa", digg_count: 0, create_time: 2, parent: "9001" },
    ],
    stopReason: "exhausted",
    expansions: 1,
    order: "page",
    reportedTotal: 3,
  },
  ...over,
});

/**
 * Chrome, the page, the CDN and the Hub, all in memory. `page(msg, tabId)`
 * answers FBW_ANALYSIS_COLLECT; tabs keep the URL they were opened with.
 */
function world({ page = () => pageAnswer(), cdn = () => stream([mp4()]), embed = () => html(404, ""), blocked = null, busy = () => false, transcribe, uploads } = {}) {
  const data = {};
  const tabs = new Map();
  const log = { created: [], removed: [], reloaded: [], puts: [], evidence: [], cdn: [], embeds: [], paused: [], sent: [], transcribed: [], slept: 0 };
  let nextTab = 10;
  let clock = 1_000_000;
  const chrome = {
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: structuredClone(data[key]) } : {}),
        set: async (obj) => Object.assign(data, structuredClone(obj)),
      },
    },
    tabs: {
      create: async ({ url, active }) => {
        const id = nextTab++;
        tabs.set(id, { id, url, active });
        log.created.push({ url, active });
        return { id, url };
      },
      get: async (id) => {
        if (!tabs.has(id)) throw new Error("no tab");
        return tabs.get(id);
      },
      remove: async (id) => {
        tabs.delete(id);
        log.removed.push(id);
      },
      reload: async (id) => log.reloaded.push(id),
      sendMessage: async (id, msg) => {
        log.sent.push(msg.type);
        if (!tabs.has(id)) throw new Error("no tab");
        if (msg.type === "FBW_PING") return { ok: true, spy: true };
        if (msg.type === "FBW_ANALYSIS_COLLECT") return page(msg, id, api);
        return { ok: true };
      },
    },
  };
  let uploadCalls = 0;
  const fetchImpl = async (url, init = {}) => {
    if (url.includes("/embed/captioned/")) {
      log.embeds.push({ url, credentials: init.credentials });
      return embed(url);
    }
    if (url.startsWith("https://scontent")) {
      log.cdn.push(url);
      return cdn(url, log.cdn.length);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const api = createAnalysisCollect({
    chrome,
    fetchImpl,
    instagram: {
      blocked: async () => blocked,
      busy: async () => busy(),
      pause: async (code) => log.paused.push(code),
      serialize: (work) => work(),
    },
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      log.slept += ms;
    },
    random: () => 0.5,
  });
  return { api, chrome, data, tabs, log, advance: (ms) => (clock += ms), now: () => clock };
}


describe("cancelPrepare and recovery", () => {

  it("after a worker restart, closes the lost job's own tab and forgets the job", async () => {
    const w = world();
    w.tabs.set(7, { id: 7, url: `https://www.instagram.com/p/CCC/${ANALYSIS_MARKER}` });
    w.tabs.set(8, { id: 8, url: "https://www.instagram.com/p/CCC/" });
    w.data[ANALYSIS_COLLECT_KEY] = { taskId: "t0", tabId: 7, startedAt: 1, nextAt: 5 };
    await w.api.recover();
    expect(w.log.removed).toEqual([7]);
    expect(w.data[ANALYSIS_COLLECT_KEY]).toMatchObject({ taskId: null, tabId: null, nextAt: 5 });

    w.data[ANALYSIS_COLLECT_KEY] = { taskId: "t0", tabId: 8, startedAt: 1, nextAt: 5 };
    await w.api.recover();
    expect(w.log.removed).toEqual([7]); // the user's tab stays
  });
});

describe("sweepComments", () => {
  it("reads each listed post's thread in a tab of its own, one at a time, 20–40 s apart, at most 15", async () => {
    const asked = [];
    const w = world({
      page: (msg) => {
        asked.push([msg.code, msg.comments]);
        return pageAnswer({ code: msg.code });
      },
    });
    const codes = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const before = w.log.slept;
    const out = await w.api.sweepComments(["../bad", "C0", ...codes]);
    expect(out).toEqual({ ok: true, done: 15, total: 15, stopReason: null });
    expect(asked).toHaveLength(15);
    expect(asked.every(([, comments]) => comments === true)).toBe(true);
    expect(w.log.created[0]).toEqual({ url: `https://www.instagram.com/p/C0/${ANALYSIS_MARKER}`, active: false });
    expect(w.log.removed).toHaveLength(15);
    expect(w.log.slept - before).toBeGreaterThanOrEqual(14 * 20_000);
    // Comments only: no video, no Hub, no transcription.
    expect(w.log.cdn).toEqual([]);
    expect(w.log.puts).toEqual([]);
    expect(w.log.evidence).toEqual([]);
    expect(w.log.transcribed).toEqual([]);
    expect(w.api.sweepStatus()).toMatchObject({ running: false, done: 15, total: 15 });
  });

  it("a rate limit on its tab stops the sweep and pauses Instagram", async () => {
    let n = 0;
    const w = world({
      page: (_msg, tabId, api) => {
        if (++n === 2) api.onResponse({ tabId, statusCode: 429, url: "https://www.instagram.com/api/graphql" });
        return pageAnswer();
      },
    });
    expect(await w.api.sweepComments(["A1", "A2", "A3"])).toEqual({ ok: true, done: 1, total: 3, stopReason: "rate_limited" });
    expect(w.log.paused).toEqual(["rate_limited"]);
  });

  it("can be stopped, and refuses a second sweep while one runs", async () => {
    let api;
    const w = world({
      page: async (_msg, _tabId, a) => {
        api = a;
        expect(await a.sweepComments(["Z9"])).toEqual({ ok: false, code: "busy" });
        a.stopSweep();
        return pageAnswer();
      },
    });
    const out = await w.api.sweepComments(["B1", "B2", "B3"]);
    expect(out.stopReason).toBe("cancelled");
    expect(out.done).toBeLessThan(3);
    expect(api).toBeTruthy();
  });

  it("opens nothing while Instagram is paused", async () => {
    const w = world({ blocked: "login_required" });
    expect(await w.api.sweepComments(["A1"])).toEqual({ ok: true, done: 0, total: 1, stopReason: "instagram_paused" });
    expect(w.log.created).toEqual([]);
  });
});
