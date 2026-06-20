// Velix stream extractor
// ----------------------------------------------------------------------------
// Runs headless Chromium (Puppeteer) to resolve a playable .m3u8 from an embed
// provider — the same thing BrowseHere does natively. Because it drives a real
// browser engine, it sees streams inside cross-origin iframes and captures the
// exact Referer/Origin/cookies the player used, so the URL plays without 403s.
//
// GET /extract?type=movie&id=550
// GET /extract?type=tv&id=1399&season=1&episode=1
// GET /extract?url=https://vsembed.ru/embed/550/        (explicit embed URL)
// optional &provider=vsembed|vidfast|vidking            (default: tries in order)
//
// Response: { ok, m3u8, referer, origin, headers, provider, ms } or { ok:false }

import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Provider URL builders -------------------------------------------------
const PROVIDERS = {
  vsembed: ({ type, id, season, episode }) =>
    type === "movie"
      ? `https://vsembed.ru/embed/${id}/`
      : `https://vsembed.ru/embed/${id}/${season}-${episode}/`,
  vidfast: ({ type, id, season, episode }) =>
    type === "movie"
      ? `https://vidfast.pro/movie/${id}`
      : `https://vidfast.pro/tv/${id}/${season}/${episode}`,
  vidking: ({ type, id, season, episode }) =>
    type === "movie"
      ? `https://www.vidking.net/embed/movie/${id}`
      : `https://www.vidking.net/embed/tv/${id}/${season}/${episode}`,
};
const PROVIDER_ORDER = ["vsembed", "vidfast", "vidking"];

// ---- Ad / tracker host blocklist (substring match) -------------------------
const AD_MARKERS = [
  "doubleclick", "googlesyndication", "googleadservices", "google-analytics",
  "googletagmanager", "adservice.google", "adnxs", "rubiconproject", "pubmatic",
  "criteo", "smartadserver", "openx", "casalemedia", "popads", "popcash",
  "popunder", "propellerads", "propeller", "adsterra", "hilltopads", "exoclick",
  "exosrv", "juicyads", "trafficstars", "trafficjunky", "clickadu", "adskeeper",
  "admaven", "ad-maven", "mgid.com", "a-ads", "adcash", "onclickads", "onclckds",
  "bidvertiser", "revcontent", "taboola", "outbrain", "zeydoo", "galaksion",
  "clickadilla", "tsyndicate", "twinrdsrv", "scorecardresearch", "quantserve",
  "hotjar", "mixpanel", "amplitude", "sentry.io", "clarity.ms", "onesignal",
  "pushwoosh", "histats", "statcounter", "mc.yandex", "yandex.ru", "facebook.net",
  "fbcdn", "/cdn-cgi/rum", "/beacon", "disable-devtool", "/vast", "/vpaid",
  "imasdk", "vmap", "preroll", "midroll", "/ads/", "/ads.",
];
const isAd = (u) => {
  const l = u.toLowerCase();
  return AD_MARKERS.some((m) => l.includes(m));
};

// ---- m3u8 detection --------------------------------------------------------
const isM3u8 = (u) => {
  const l = u.toLowerCase();
  return (
    l.includes(".m3u8") ||
    l.includes("load-playlist") ||
    (l.includes("/playlist/") && l.includes("/caxi"))
  );
};
const isAdM3u8 = (u) => {
  const l = u.toLowerCase();
  return ["/vast", "vmap", "/ads/", "/ad/", "preroll", "midroll",
          "doubleclick", "imasdk", "adserver", "/vpaid"].some((m) => l.includes(m));
};

// ---- Browser singleton (reused across requests) ----------------------------
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
        "--window-size=1280,720",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--lang=en-US,en",
      ],
    });
  }
  return browserPromise;
}

// ---- Capture one provider --------------------------------------------------
async function captureFrom(embedUrl, timeoutMs = 22000) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let resolved = null;

  await page.setUserAgent(
    "Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36"
  );
  await page.setViewport({ width: 1280, height: 720 });

  // Headless-evasion: hide navigator.webdriver and stub a couple of the
  // signals these embeds check before serving the player.
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    window.chrome = { runtime: {} };
  });
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Block ads + images at the request level (faster init, no ad m3u8s).
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    const rt = req.resourceType();
    if (isAd(url) || rt === "image" || rt === "font") {
      req.abort().catch(() => {});
    } else {
      req.continue().catch(() => {});
    }
  });

  // Watch every response for the real m3u8. This sees inside cross-origin
  // iframes — the key advantage over an in-app WebView.
  const onResponseOrRequest = (reqOrRes) => {
    if (resolved) return;
    const url = typeof reqOrRes.url === "function" ? reqOrRes.url() : reqOrRes;
    // DIAG: log anything that looks remotely like a playlist/segment so we can
    // see in the Railway logs whether the stream ever fires.
    const l = url.toLowerCase();
    if (l.includes("m3u8") || l.includes(".ts") || l.includes("playlist")) {
      console.log(`  [m3u8?] ${url.slice(0, 140)}`);
    }
    if (isM3u8(url) && !isAdM3u8(url)) {
      const headers =
        typeof reqOrRes.headers === "function" ? reqOrRes.headers() : {};
      resolved = {
        m3u8: url,
        referer: headers["referer"] || headers["Referer"] || "",
        origin: headers["origin"] || headers["Origin"] || "",
      };
      console.log(`  [CAPTURED] ${url.slice(0, 140)}`);
    }
  };
  page.on("request", onResponseOrRequest);
  page.on("response", (res) => onResponseOrRequest(res.request()));

  try {
    console.log(`  goto: ${embedUrl}`);
    await page.goto(embedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
      referer: new URL(embedUrl).origin + "/",
    });
    console.log(`  page loaded, frames=${page.frames().length}, tapping…`);
    // DIAG: peek at what the page actually contains (helps spot block pages).
    try {
      const info = await page.evaluate(() => ({
        title: document.title,
        bodyLen: document.body ? document.body.innerHTML.length : 0,
        iframes: document.querySelectorAll("iframe").length,
        text: (document.body ? document.body.innerText : "").slice(0, 120),
      }));
      console.log(`  page: title="${info.title}" bodyLen=${info.bodyLen} iframes=${info.iframes} text="${info.text.replace(/\n/g, " ")}"`);

      // If Cloudflare served a challenge, wait for it to auto-solve (the stealth
      // plugin often passes the JS challenge within a few seconds). Re-check the
      // title until it's no longer the Cloudflare interstitial.
      if (info.title.includes("Cloudflare") || info.text.includes("Checking your browser") ||
          info.text.includes("you have been blocked") || info.text.includes("Just a moment")) {
        console.log(`  cloudflare challenge detected — waiting up to 15s…`);
        const cfStart = Date.now();
        while (Date.now() - cfStart < 15000) {
          await new Promise((r) => setTimeout(r, 1500));
          const t = await page.title().catch(() => "");
          if (!t.includes("Cloudflare") && !t.includes("Just a moment")) {
            console.log(`  cloudflare cleared → "${t}"`);
            break;
          }
        }
        const stillBlocked = (await page.title().catch(() => "")).includes("Cloudflare");
        if (stillBlocked) console.log(`  cloudflare still blocking after wait`);
      }
    } catch (e) {}

    // Nudge playback: click the player area + call .play() on any <video>,
    // including inside same-origin frames. Cross-origin frames start on their
    // own once autoplay policy is relaxed (flag above).
    const start = Date.now();
    while (!resolved && Date.now() - start < timeoutMs) {
      try {
        await page.mouse.click(640, 360);
        for (const frame of page.frames()) {
          frame
            .evaluate(() => {
              document.querySelectorAll("video").forEach((v) => {
                try { v.muted = false; v.play(); } catch (e) {}
              });
              ["[class*='play']", ".vjs-big-play-button",
               ".plyr__control--overlaid", "button"].forEach((s) =>
                document.querySelectorAll(s).forEach((el) => {
                  try { el.click(); } catch (e) {}
                })
              );
            })
            .catch(() => {});
        }
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 400));
    }

    if (resolved && !resolved.referer) {
      // Fall back to the embed host if the request didn't expose a referer.
      resolved.referer = new URL(embedUrl).origin + "/";
    }
    if (resolved && !resolved.origin && resolved.referer) {
      try { resolved.origin = new URL(resolved.referer).origin; } catch (e) {}
    }
    return resolved;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---- Routes ----------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/extract", async (req, res) => {
  const t0 = Date.now();
  const { url, provider, type = "movie", id, season = "1", episode = "1" } =
    req.query;

  // Build the list of embed URLs to try.
  let attempts = [];
  if (url) {
    attempts = [{ provider: provider || "custom", embed: url }];
  } else if (id) {
    const params = { type, id, season, episode };
    const order = provider ? [provider] : PROVIDER_ORDER;
    attempts = order
      .filter((p) => PROVIDERS[p])
      .map((p) => ({ provider: p, embed: PROVIDERS[p](params) }));
  } else {
    return res.status(400).json({ ok: false, error: "need url or id" });
  }

  for (const a of attempts) {
    try {
      console.log(`[extract] trying ${a.provider}: ${a.embed}`);
      const r = await captureFrom(a.embed);
      if (r && r.m3u8) {
        return res.json({
          ok: true,
          provider: a.provider,
          m3u8: r.m3u8,
          referer: r.referer,
          origin: r.origin,
          ms: Date.now() - t0,
        });
      }
    } catch (e) {
      // try next provider
    }
  }
  return res.json({ ok: false, error: "no stream captured", ms: Date.now() - t0 });
});

app.listen(PORT, () => console.log(`velix-extractor listening on ${PORT}`));
