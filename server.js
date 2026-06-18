const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 4173;
const cacheMs = Number(process.env.CACHE_MS || 60 * 1000);
const cacheFile = path.join(root, "data", "availability.json");
const tbcConcurrency = Number(process.env.TBC_CONCURRENCY || 2);
const ubcConcurrency = Number(process.env.UBC_CONCURRENCY || 2);
const refreshTimeoutMs = Number(process.env.REFRESH_TIMEOUT_MS || 8 * 60 * 1000);
const refreshRetryMs = Number(process.env.REFRESH_RETRY_MS || 60 * 1000);
const backgroundRefreshMs = Number(process.env.BACKGROUND_REFRESH_MS || 5 * 60 * 1000);
const openRefreshWaitMs = Number(process.env.OPEN_REFRESH_WAIT_MS || 45 * 1000);
const remoteCacheMs = Number(process.env.REMOTE_CACHE_MS || 60 * 1000);
const availabilityCacheApiUrl =
  "https://api.github.com/repos/Jing1234321/tennis/contents/data/availability.json?ref=availability-cache";
let cachedAvailability = null;
let cachedAt = 0;
let remoteCachedAt = 0;
let inFlightAvailability = null;
let lastRefreshStartedAt = 0;
let lastRefreshError = null;
let playwrightModule = null;

try {
  const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  if (persisted && persisted.updatedAt) {
    cachedAvailability = persisted;
    cachedAt = new Date(persisted.checkedAt || persisted.updatedAt).getTime();
  }
} catch {
  cachedAvailability = null;
}

const tbcUrl = (dateISO) =>
  `https://clubspark.ca/tbchubrichmond/Booking/BookByDate#?date=${dateISO}&role=guest`;

const ubcListUrl =
  "https://ubc.perfectmind.com/24063/Clients/BookMe4FacilityList/List?calendarId=e65c1527-c4f8-4316-b6d6-3b174041f00e&embed=False&singleCalendarWidget=true&widgetId=c7c36ee3-2494-4de2-b2cb-d50a86487656";

const ubcCourtFacilityIds = {
  "1": "c0668c1c-1fd6-4432-a20e-4c50aaad5baa",
  "2": "e2d99dda-cdc4-4af4-8df6-6c8061ffd56f",
  "3": "c117a102-0ba0-4aa8-b8cf-eb8a1480be55",
  "4": "47f78e62-2ac0-4d39-8ffa-5d331f60e14e",
  "5": "e5432c07-c2a6-46d1-a5d7-25c58567046c",
  "6": "f7000b6c-0d93-472b-97af-e0f22915439f",
  "7": "5dac0879-1fbb-4dfe-ac67-5dcaa925d2f5",
  "8": "ccbf3aa0-f263-44eb-b394-a603115f587a",
  "9": "9f475d76-dbc1-463e-9097-210f31681e2f",
  "10": "d5894b7a-2b61-4345-a1a8-ea8a50c921ae",
};

function ubcCourtUrl(court, dateISO) {
  const params = new URLSearchParams({
    facilityId: ubcCourtFacilityIds[court],
    widgetId: "c7c36ee3-2494-4de2-b2cb-d50a86487656",
    calendarId: "e65c1527-c4f8-4316-b6d6-3b174041f00e",
    arrivalDate: `${dateISO}T19:30:00.000Z`,
    landingPageBackUrl:
      "https://ubc.perfectmind.com/24063/Clients/BookMe4FacilityList/List?widgetId=c7c36ee3-2494-4de2-b2cb-d50a86487656&calendarId=e65c1527-c4f8-4316-b6d6-3b174041f00e",
  });

  return `https://ubc.perfectmind.com/24063/Clients/BookMe4LandingPages/Facility?${params.toString()}`;
}

function getWeekDays() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const today = `${parts.find((part) => part.type === "year").value}-${parts.find((part) => part.type === "month").value}-${parts.find((part) => part.type === "day").value}`;

  return Array.from({ length: 7 }, (_, index) => addDays(today, index));
}

function addDays(dateISO, days) {
  const [year, month, day] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function isWeekend(dateISO) {
  const [year, month, day] = dateISO.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

function targetWindow(dateISO) {
  return isWeekend(dateISO)
    ? { start: 14 * 60, end: 23 * 60 }
    : { start: 19 * 60 + 30, end: 23 * 60 };
}

function parseClock(value) {
  const match = String(value || "").match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toUpperCase();
  if (meridiem === "PM" && hours !== 12) hours += 12;
  if (meridiem === "AM" && hours === 12) hours = 0;
  return hours * 60 + minutes;
}

function normalizeTimeRange(value) {
  const [startRaw, endRaw] = String(value || "").split("-");
  const start = parseClock(startRaw);
  const end = parseClock(endRaw);
  if (start === null || end === null) return null;
  return `${toTime(start)}-${toTime(end)}`;
}

function inTargetWindow(dateISO, range) {
  const [startRaw, endRaw] = String(range || "").split("-");
  const start = parseClock(startRaw);
  const end = parseClock(endRaw);
  if (start === null || end === null) return false;
  const window = targetWindow(dateISO);
  return end > window.start && start < window.end;
}

function parseHeaderDate(text, baseYear) {
  const match = String(text || "").match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/i);
  if (!match) return null;
  const months = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  const month = months[match[1].toLowerCase()];
  const day = Number(match[2]);
  return `${baseYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function cookieHeader(response) {
  const cookies = response.headers.getSetCookie?.() || [];
  return cookies.map((cookie) => cookie.split(";")[0]).filter(Boolean).join("; ");
}

function extractUbcConfig(html) {
  const token = html.match(/name="__RequestVerificationToken"[^>]+value="([^"]+)"/)?.[1];
  const serviceId =
    html.match(/"ID":"([0-9a-f-]{36})","Name":"Facility Rental - Public"/i)?.[1] ||
    html.match(/"ID":"([0-9a-f-]{36})"[^}]+Facility Rental - Public/i)?.[1];
  const durationBlock = html.match(/"DurationIDs":\[(.*?)\]/)?.[1] || "";
  const durationIds = Array.from(durationBlock.matchAll(/"([0-9a-f-]{36})"/gi)).map((match) => match[1]);

  if (!token || !serviceId || durationIds.length === 0) {
    throw new Error("Could not parse UBC availability parameters");
  }

  return { token, serviceId, durationIds };
}

function parseUbcDate(value) {
  const ticks = String(value || "").match(/Date\((\d+)\)/)?.[1];
  if (!ticks) return null;
  return new Date(Number(ticks)).toISOString().slice(0, 10);
}

function minutesFromUbcTime(value) {
  const total = Number(value?.TotalMinutes);
  if (Number.isFinite(total)) return total;
  const hours = Number(value?.Hours);
  const minutes = Number(value?.Minutes);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      results.push(await fn(current));
    }
  });
  await Promise.all(workers);
  return results;
}

async function withRetry(fn, attempts, label) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.error(`${label} attempt ${attempt} failed:`, error.message);
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastError.message}`);
}

function mimeType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
  }[ext] || "application/octet-stream";
}

function cacheHeaders(filePath) {
  const ext = path.extname(filePath);
  if ([".html", ".css", ".js"].includes(ext)) {
    return { "cache-control": "no-store, max-age=0" };
  }
  return { "cache-control": "public, max-age=3600" };
}

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function emptyAvailability(refreshing = false) {
  const dates = getWeekDays();
  return {
    updatedAt: null,
    source: "warming-up",
    refreshing,
    tbc: Object.fromEntries(dates.map((date) => [date, []])),
    ubc: Object.fromEntries(dates.map((date) => [date, []])),
  };
}

function availabilityTime(data) {
  return new Date(data?.checkedAt || data?.updatedAt || 0).getTime() || 0;
}

function keepNewestAvailability(next) {
  if (!next?.updatedAt) return cachedAvailability;
  if (!cachedAvailability || availabilityTime(next) >= availabilityTime(cachedAvailability)) {
    cachedAvailability = next;
    cachedAt = availabilityTime(next);
  }
  return cachedAvailability;
}

async function fetchAvailabilityCache(triggerRefresh = false) {
  if (triggerRefresh) {
    const refreshTask = refreshInBackground();
    const refreshed = await Promise.race([
      refreshTask,
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), openRefreshWaitMs);
        timer.unref?.();
      }),
    ]);
    if (refreshed) {
      return { ...refreshed, cached: false, remoteCached: false, refreshing: Boolean(inFlightAvailability) };
    }
  }

  if (cachedAvailability && Date.now() - remoteCachedAt < remoteCacheMs) {
    return { ...cachedAvailability, cached: true, remoteCached: true, refreshing: Boolean(inFlightAvailability) };
  }

  const response = await fetch(`${availabilityCacheApiUrl}&ts=${Date.now()}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "tennis-availability",
    },
  });
  if (!response.ok) throw new Error(`GitHub availability cache failed: ${response.status}`);

  const payload = await response.json();
  if (!payload.content) throw new Error("GitHub availability cache response was empty");

  const data = JSON.parse(Buffer.from(String(payload.content).replace(/\n/g, ""), "base64").toString("utf8"));
  keepNewestAvailability(data);
  remoteCachedAt = Date.now();
  return { ...cachedAvailability, cached: true, remoteCached: true, refreshing: Boolean(inFlightAvailability) };
}

function totalSlots(data) {
  if (!data) return 0;
  const tbcTotal = Object.values(data.tbc || {}).reduce((sum, slots) => sum + slots.length, 0);
  const ubcTotal = Object.values(data.ubc || {}).reduce((sum, slots) => sum + slots.length, 0);
  return tbcTotal + ubcTotal;
}

function sourceTotals(data) {
  return {
    tbc: Object.values(data?.tbc || {}).reduce((sum, slots) => sum + slots.length, 0),
    ubc: Object.values(data?.ubc || {}).reduce((sum, slots) => sum + slots.length, 0),
  };
}

function writeAvailabilityCache() {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cachedAvailability, null, 2));
  } catch (error) {
    console.error("Could not write availability cache:", error.message);
  }
}

function getChromium() {
  if (!playwrightModule) {
    try {
      playwrightModule = require("playwright");
    } catch {
      throw new Error("实时抓取需要先安装 Playwright：npm install");
    }
  }
  return playwrightModule.chromium;
}

async function scrapeTbc(page, dateISO) {
  const window = targetWindow(dateISO);
  await page.goto(tbcUrl(dateISO), { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector(".booking-sheet", { timeout: 20000 });
  await page.waitForTimeout(700);

  return page.evaluate((window) => {
    function minutes(value) {
      const [h, m] = value.split(":").map(Number);
      return h * 60 + m;
    }

    function time(value) {
      return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    }

    function duration(el) {
      const computed = Number((getComputedStyle(el).height || "").replace("px", "")) || 0;
      const inline = Number((el.getAttribute("style") || "").match(/height:\s*(\d+)px/)?.[1] || 0);
      const interval = el.querySelector(".resource-interval") || el;
      const intervalInline = Number((interval.getAttribute("style") || "").match(/height:\s*(\d+)px/)?.[1] || 0);
      const height = computed || inline || intervalInline || 60;
      return Math.max(30, Math.round(height / 60) * 30);
    }

    const slots = [];
    const resourceLis = Array.from(document.querySelectorAll("li.visible, li.last-visible-slide")).filter((el) =>
      /Bubble Court\s*\d+/i.test(el.textContent || ""),
    );

    for (const li of resourceLis) {
      const court = (li.textContent || "").match(/Bubble Court\s*(\d+)/i)?.[1];
      if (!court) continue;

      let cursor = 6 * 60;
      for (const session of Array.from(li.querySelectorAll(".sessions-container > .resource-session"))) {
        const text = (session.textContent || "").replace(/\s+/g, " ").trim();
        const explicit = text.match(/(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/);

        if (/Available for Member/i.test(text)) {
          const start = cursor;
          const end = cursor + duration(session);
          if (end > window.start && start < window.end) {
            slots.push({ court, time: `${time(start)}-${time(end)}`, status: "可以预定" });
          }
          cursor = end;
        } else if (explicit) {
          cursor = minutes(explicit[2]);
        } else {
          cursor += duration(session);
        }
      }
    }

    return slots;
  }, window);
}

async function scrapeUbc(page, dateISO) {
  await page.goto(ubcCourtUrl("1", dateISO), { waitUntil: "commit", timeout: 30000 });
  await page.waitForSelector("#scheduler", { state: "attached", timeout: 30000 });
  return page.evaluate(() => /Bookable 24hrs in advance/i.test(document.body?.innerText || ""));
}

async function waitForUbcSchedule(page) {
  await page.waitForSelector("#scheduler", { state: "attached", timeout: 30000 });
  await page
    .waitForFunction(
      () =>
        /Bookable 24hrs in advance|Book Now/i.test(document.body?.innerText || "") ||
        document.querySelectorAll("#scheduler .k-event").length > 0,
      { timeout: 12000 },
    )
    .catch(() => {});
}

async function scrapeUbcCourt(court, startDateISO, targetDates) {
  const pageUrl = ubcCourtUrl(court, startDateISO);
  const pageResponse = await fetch(pageUrl, {
    headers: {
      "user-agent": "Mozilla/5.0",
    },
  });
  if (!pageResponse.ok) throw new Error(`UBC court page failed: ${pageResponse.status}`);

  const html = await pageResponse.text();
  const cookies = cookieHeader(pageResponse);
  const { token, serviceId, durationIds } = extractUbcConfig(html);
  const body = new URLSearchParams({
    facilityId: ubcCourtFacilityIds[court],
    date: `${startDateISO}T00:00:00.000Z`,
    daysCount: "7",
    duration: "60",
    serviceId,
    __RequestVerificationToken: token,
  });
  for (const id of durationIds) {
    body.append("durationIds[]", id);
  }

  const availabilityResponse = await fetch(
    "https://ubc.perfectmind.com/24063/Clients/BookMe4LandingPages/FacilityAvailability",
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": "Mozilla/5.0",
        referer: pageUrl,
        cookie: cookies,
      },
      body,
    },
  );
  if (!availabilityResponse.ok) throw new Error(`UBC availability failed: ${availabilityResponse.status}`);

  const payload = await availabilityResponse.json();
  const slots = [];
  for (const day of payload.availabilities || []) {
    const dateISO = parseUbcDate(day.Date);
    if (!dateISO || !targetDates.has(dateISO)) continue;

    for (const group of day.BookingGroups || []) {
      for (const spot of group.AvailableSpots || []) {
        const title = String(spot.Title || "");
        if (title && !/(Bookable 24hrs in advance|Book Now|Reserve)/i.test(title)) continue;

        const start = minutesFromUbcTime(spot.Time);
        const duration = minutesFromUbcTime(spot.Duration);
        if (start === null || duration === null) continue;

        const time = `${toTime(start)}-${toTime(start + duration)}`;
        if (!inTargetWindow(dateISO, time)) continue;

        slots.push({
          dateISO,
          court,
          time,
          status: "可以预定",
          href: ubcCourtUrl(court, dateISO),
        });
      }
    }
  }

  return slots;
}

function dedupeSlots(slots) {
  const seen = new Set();
  return slots
    .filter((slot) => {
      const key = `${slot.dateISO || ""}|${slot.court}|${slot.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => Number(a.court) - Number(b.court) || a.time.localeCompare(b.time));
}

async function availability(forceRefresh = false) {
  releaseExpiredRefresh();

  if (!forceRefresh && cachedAvailability && Date.now() - cachedAt < cacheMs) {
    return { ...cachedAvailability, cached: true };
  }

  if (inFlightAvailability) {
    const refreshed = await inFlightAvailability;
    if (refreshed) return refreshed;
    if (cachedAvailability) return { ...cachedAvailability, cached: true, stale: true, refreshError: lastRefreshError };
    return emptyAvailability(false);
  }

  inFlightAvailability = startAvailabilityRefresh("Availability refresh");
  const refreshed = await inFlightAvailability;
  if (refreshed) return refreshed;
  if (cachedAvailability) return { ...cachedAvailability, cached: true, stale: true, refreshError: lastRefreshError };
  return emptyAvailability(false);
}

function startAvailabilityRefresh(label) {
  lastRefreshStartedAt = Date.now();
  lastRefreshError = null;
  let task;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${refreshTimeoutMs}ms`)), refreshTimeoutMs + 5000);
    timer.unref?.();
  });

  task = Promise.race([scrapeAvailability(), timeout])
    .catch((error) => {
      console.error(`${label} failed:`, error.message);
      lastRefreshError = error.message;
      return null;
    })
    .finally(() => {
      clearTimeout(timer);
      if (inFlightAvailability === task) {
        inFlightAvailability = null;
      }
    });

  return task;
}

function releaseExpiredRefresh() {
  if (!inFlightAvailability) return;
  const refreshAgeMs = Date.now() - lastRefreshStartedAt;
  if (refreshAgeMs <= refreshTimeoutMs + 15 * 1000) return;
  console.error(`Availability refresh watchdog released stuck task after ${refreshAgeMs}ms.`);
  inFlightAvailability = null;
}

function availabilityFast(forceRefresh = false, asyncRefresh = false) {
  if (forceRefresh) {
    return availability(true);
  }

  if (cachedAvailability) {
    return {
      ...cachedAvailability,
      cached: true,
      refreshing: false,
    };
  }

  return emptyAvailability(false);
}

function availabilityLive(forceRefresh = false, liveSince = 0) {
  return availability(Boolean(forceRefresh || !cachedAvailability));
}

function refreshInBackground() {
  releaseExpiredRefresh();
  if (inFlightAvailability) return inFlightAvailability;
  inFlightAvailability = startAvailabilityRefresh("Background availability refresh");
  return inFlightAvailability;
}

async function scrapeAvailability() {
  const chromium = getChromium();
  const browser = await chromium.launch({ headless: true });
  const refreshTimeout = setTimeout(() => {
    console.error("Availability refresh timed out; closing browser.");
    browser.close().catch(() => {});
  }, refreshTimeoutMs);
  refreshTimeout.unref?.();
  const dates = getWeekDays();
  const targetDates = new Set(dates);
  const tbc = {};
  const ubc = {};

  try {
    for (const date of dates) {
      tbc[date] = [];
      ubc[date] = [];
    }

    await mapLimit(dates, tbcConcurrency, async (date) => {
      const slots = await withRetry(async () => {
        const page = await browser.newPage();
        try {
          return await scrapeTbc(page, date);
        } finally {
          await page.close();
        }
      }, 2, `Tennis Hub ${date}`);
      tbc[date] = dedupeSlots(slots.map((slot) => ({ ...slot, dateISO: date })));
    });

    const startDates = [dates[0]].filter(Boolean);
    const ubcJobs = Object.keys(ubcCourtFacilityIds).flatMap((court) =>
      startDates.map((startDate) => ({ court, startDate })),
    );

    const ubcGroups = await mapLimit(ubcJobs, ubcConcurrency, ({ court, startDate }) =>
      withRetry(() => scrapeUbcCourt(court, startDate, targetDates), 2, `UBC court ${court}`),
    );
    for (const slot of ubcGroups.flat()) {
      ubc[slot.dateISO].push(slot);
    }
    for (const date of dates) {
      ubc[date] = dedupeSlots(ubc[date]);
      tbc[date] = tbc[date].map(({ dateISO, ...slot }) => slot);
      ubc[date] = ubc[date].map(({ dateISO, ...slot }) => slot);
    }
  } finally {
    clearTimeout(refreshTimeout);
    await browser.close().catch(() => {});
  }

  const checkedAt = new Date().toISOString();
  const nextAvailability = {
    updatedAt: checkedAt,
    checkedAt,
    source: "live-public-pages",
    tbc,
    ubc,
  };

  const nextTotals = sourceTotals(nextAvailability);
  const cachedTotals = sourceTotals(cachedAvailability);
  const nextTotal = nextTotals.tbc + nextTotals.ubc;
  console.log(`Availability refresh result: ${nextTotal} slots`);

  if (nextTotal === 0) {
    throw new Error("Availability refresh returned zero slots");
  }

  if ((cachedTotals.tbc > 0 && nextTotals.tbc === 0) || (cachedTotals.ubc > 0 && nextTotals.ubc === 0)) {
    throw new Error(
      `Availability refresh returned incomplete source data: Tennis Hub ${nextTotals.tbc}, UBC ${nextTotals.ubc}`,
    );
  }

  cachedAvailability = nextAvailability;
  cachedAt = Date.now();
  writeAvailabilityCache();
  return cachedAvailability;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const apiHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  };

  if (url.pathname === "/api/health") {
    releaseExpiredRefresh();
    res.writeHead(200, { ...apiHeaders, "content-type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        ok: true,
        updatedAt: cachedAvailability?.updatedAt ?? null,
        checkedAt: cachedAvailability?.checkedAt ?? null,
        refreshing: Boolean(inFlightAvailability),
        refreshAgeMs: inFlightAvailability ? Date.now() - lastRefreshStartedAt : 0,
        lastRefreshError,
        backgroundRefreshMs,
        openRefreshWaitMs,
        refreshTimeoutMs,
        refreshRetryMs,
      }),
    );
    return;
  }

  if (url.pathname === "/api/availability") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, apiHeaders);
      res.end();
      return;
    }

    try {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const asyncRefresh = url.searchParams.get("async") === "1";
      const liveRefresh = url.searchParams.get("live") === "1";
      const liveSince = Number(url.searchParams.get("liveSince") || 0);
      const data = liveRefresh ? availabilityLive(forceRefresh, liveSince) : availabilityFast(forceRefresh, asyncRefresh);
      res.writeHead(200, { ...apiHeaders, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(await data));
    } catch (error) {
      res.writeHead(500, { ...apiHeaders, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  if (url.pathname === "/api/cache") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, apiHeaders);
      res.end();
      return;
    }

    try {
      const triggerRefresh = url.searchParams.get("refresh") === "1";
      const data = await fetchAvailabilityCache(triggerRefresh);
      res.writeHead(200, { ...apiHeaders, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data));
    } catch (error) {
      if (cachedAvailability) {
        res.writeHead(200, { ...apiHeaders, "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ...cachedAvailability, cached: true, stale: true, refreshError: error.message }));
        return;
      }

      res.writeHead(500, { ...apiHeaders, "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = path.normalize(path.join(root, requestedPath));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, { "content-type": mimeType(filePath), ...cacheHeaders(filePath) });
    res.end(content);
  });
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Tennis site running at http://127.0.0.1:${port}`);
  });
}

module.exports = {
  availability,
  scrapeAvailability,
};
