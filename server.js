const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const port = process.env.PORT || 4173;
const cacheMs = 60 * 1000;
const persistedCacheMaxAgeMs = 30 * 60 * 1000;
const cacheFile = path.join(root, "data", "availability.json");
const backgroundRefreshMs = 10 * 60 * 1000;
let cachedAvailability = null;
let cachedAt = 0;
let inFlightAvailability = null;
let playwrightModule = null;

try {
  const persisted = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  const persistedAge = persisted?.updatedAt ? Date.now() - new Date(persisted.updatedAt).getTime() : Infinity;
  if (persisted && persisted.updatedAt && persistedAge < persistedCacheMaxAgeMs) {
    cachedAvailability = persisted;
    cachedAt = Date.now();
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
  await page.waitForSelector(".booking-sheet", { timeout: 12000 }).catch(() => {});
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
  await page.goto(ubcCourtUrl("1", dateISO), { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#scheduler", { timeout: 12000 }).catch(() => {});
  return page.evaluate(() => /Bookable 24hrs in advance/i.test(document.body?.innerText || ""));
}

async function scrapeUbcCourt(browser, court, startDateISO, targetDates) {
  const page = await browser.newPage();
  try {
    await page.goto(ubcCourtUrl(court, startDateISO), { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#scheduler", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(800);
    const baseYear = Number(startDateISO.slice(0, 4));
    const slots = await page.evaluate(() => {
      function tidy(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      const headers = Array.from(
        document.querySelectorAll(".k-scheduler-header th, .k-scheduler-header td, th.k-scheduler-datecolumn, .k-scheduler-datecolumn"),
      )
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            text: tidy(el.innerText || el.textContent),
            left: rect.x,
            right: rect.x + rect.width,
            center: rect.x + rect.width / 2,
          };
        })
        .filter((header) => /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/i.test(header.text));

      return Array.from(document.querySelectorAll("#scheduler .k-event"))
        .map((event) => {
          const text = tidy(event.innerText || event.textContent);
          if (!/Bookable 24hrs in advance/i.test(text)) return null;
          const rect = event.getBoundingClientRect();
          const center = rect.x + rect.width / 2;
          const header =
            headers.find((item) => center >= item.left && center <= item.right) ||
            headers.reduce((best, item) => {
              if (!best) return item;
              return Math.abs(item.center - center) < Math.abs(best.center - center) ? item : best;
            }, null);
          const time = event.querySelector("[title]")?.getAttribute("title") || "";
          return header && time ? { header: header.text, time } : null;
        })
        .filter(Boolean);
    });

    return slots
      .map((slot) => {
        const dateISO = parseHeaderDate(slot.header, baseYear);
        const time = normalizeTimeRange(slot.time);
        if (!dateISO || !time || !targetDates.has(dateISO) || !inTargetWindow(dateISO, slot.time)) return null;
        return {
          dateISO,
          court,
          time,
          status: "可以预定",
          href: ubcCourtUrl(court, dateISO),
        };
      })
      .filter(Boolean);
  } finally {
    await page.close();
  }
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

async function availability() {
  if (cachedAvailability && Date.now() - cachedAt < cacheMs) {
    return { ...cachedAvailability, cached: true };
  }

  if (inFlightAvailability) return inFlightAvailability;

  inFlightAvailability = scrapeAvailability().finally(() => {
    inFlightAvailability = null;
  });
  return inFlightAvailability;
}

function availabilityFast(forceRefresh = false) {
  const hasCache = Boolean(cachedAvailability);
  const isFresh = hasCache && Date.now() - cachedAt < cacheMs;

  if ((forceRefresh || !isFresh) && !inFlightAvailability) {
    inFlightAvailability = scrapeAvailability()
      .catch((error) => {
        console.error("Availability refresh failed:", error.message);
        return null;
      })
      .finally(() => {
        inFlightAvailability = null;
      });
  }

  if (hasCache) {
    return {
      ...cachedAvailability,
      cached: true,
      refreshing: Boolean(inFlightAvailability),
    };
  }

  if (!inFlightAvailability) {
    inFlightAvailability = scrapeAvailability()
      .catch((error) => {
        console.error("Initial availability refresh failed:", error.message);
        return null;
      })
      .finally(() => {
        inFlightAvailability = null;
      });
  }

  return emptyAvailability(true);
}

function refreshInBackground() {
  if (inFlightAvailability) return;
  inFlightAvailability = scrapeAvailability()
    .catch((error) => {
      console.error("Scheduled availability refresh failed:", error.message);
      return null;
    })
    .finally(() => {
      inFlightAvailability = null;
    });
}

async function scrapeAvailability() {
  const chromium = getChromium();
  const browser = await chromium.launch({ headless: true });
  const dates = getWeekDays();
  const targetDates = new Set(dates);
  const tbc = {};
  const ubc = {};

  try {
    for (const date of dates) {
      tbc[date] = [];
      ubc[date] = [];
    }

    await mapLimit(dates, 4, async (date) => {
      const page = await browser.newPage();
      try {
        tbc[date] = dedupeSlots((await scrapeTbc(page, date).catch(() => [])).map((slot) => ({ ...slot, dateISO: date })));
      } finally {
        await page.close();
      }
    });

    const startDates = [dates[0], dates[5]].filter(Boolean);
    const ubcJobs = Object.keys(ubcCourtFacilityIds).flatMap((court) =>
      startDates.map((startDate) => ({ court, startDate })),
    );

    const ubcGroups = await mapLimit(ubcJobs, 6, ({ court, startDate }) =>
      scrapeUbcCourt(browser, court, startDate, targetDates).catch(() => []),
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
    await browser.close();
  }

  cachedAvailability = {
    updatedAt: new Date().toISOString(),
    source: "live-public-pages",
    tbc,
    ubc,
  };
  cachedAt = Date.now();
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(cachedAvailability, null, 2));
  } catch (error) {
    console.error("Could not write availability cache:", error.message);
  }
  return cachedAvailability;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/availability") {
    try {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const data = availabilityFast(forceRefresh);
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(await data));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
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

    res.writeHead(200, { "content-type": mimeType(filePath) });
    res.end(content);
  });
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`Tennis site running at http://127.0.0.1:${port}`);
  });

  setTimeout(refreshInBackground, 1500);
  setInterval(refreshInBackground, backgroundRefreshMs);
}

module.exports = {
  availability,
  scrapeAvailability,
};
