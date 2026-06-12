const courts = [
  {
    id: "tbc",
    name: "Tennis Hub Richmond",
    shortName: "Tennis Hub",
    color: "var(--green)",
    status: "点开查晚场",
    note: "ClubSpark 会按日期显示空位。",
    bookingUrlForDate(dateISO) {
      return `https://clubspark.ca/tbchubrichmond/Booking/BookByDate#?date=${dateISO}&role=guest`;
    },
  },
  {
    id: "ubc",
    name: "UBC Tennis Centre",
    shortName: "UBC",
    color: "var(--blue)",
    status: "点开查晚场",
    note: "UBC 标准订场最多提前 24 小时开放。",
    bookingUrlForDate() {
      return "https://recreation.ubc.ca/tennis/court-booking/";
    },
  },
];

const ubcBookingUrl =
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

function getUbcCourtUrl(court, dateISO) {
  const facilityId = ubcCourtFacilityIds[court];
  if (!facilityId) return ubcBookingUrl;

  const params = new URLSearchParams({
    facilityId,
    widgetId: "c7c36ee3-2494-4de2-b2cb-d50a86487656",
    calendarId: "e65c1527-c4f8-4316-b6d6-3b174041f00e",
    arrivalDate: `${dateISO}T19:30:00.000Z`,
    landingPageBackUrl:
      "https://ubc.perfectmind.com/24063/Clients/BookMe4FacilityList/List?widgetId=c7c36ee3-2494-4de2-b2cb-d50a86487656&calendarId=e65c1527-c4f8-4316-b6d6-3b174041f00e",
  });

  return `https://ubc.perfectmind.com/24063/Clients/BookMe4LandingPages/Facility?${params.toString()}`;
}

const ubcEveningAvailability = {
  default: [],
};

const tbcEveningAvailability = {
  default: [],
};

let liveAvailability = {
  updatedAt: null,
  tbc: {},
  ubc: {},
};

const richmond = { label: "Richmond", latitude: 49.1666, longitude: -123.1336 };

const weatherCodes = {
  0: ["晴", "☀"],
  1: ["大致晴", "🌤"],
  2: ["局部多云", "⛅"],
  3: ["多云", "☁"],
  45: ["雾", "☁"],
  48: ["霜雾", "☁"],
  51: ["小毛雨", "🌦"],
  53: ["毛雨", "🌦"],
  55: ["强毛雨", "🌧"],
  61: ["小雨", "🌧"],
  63: ["雨", "🌧"],
  65: ["大雨", "🌧"],
  80: ["阵雨", "🌦"],
  81: ["阵雨", "🌦"],
  82: ["强阵雨", "🌧"],
  95: ["雷雨", "⛈"],
};

const forecastGrid = document.querySelector("#forecastGrid");
const weekList = document.querySelector("#weekList");
const availabilityOverview = document.querySelector("#availabilityOverview");
const availabilityStatus = document.querySelector("#availabilityStatus");
const refreshButton = document.querySelector("#refreshButton");
const autoRefreshMs = 60 * 1000;
const refreshPollMs = 15 * 1000;
const productionOrigin = "https://tennis-783m.onrender.com";
let availabilityPollTimer = null;
let availabilityRequestId = 0;

function getWeekDays() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index);
    const iso = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
    const label = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);
    return { date, iso, weekday, label };
  });
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function getCourtWindow(day) {
  return isWeekend(day.date)
    ? { label: "14:00-23:00", startLabel: "14:00" }
    : { label: "19:30 后", startLabel: "19:30" };
}

function getUbcSlotsForDay(day) {
  return liveAvailability.ubc[day.iso] ?? ubcEveningAvailability[day.iso] ?? ubcEveningAvailability.default;
}

function formatUpdatedAt(value) {
  if (!value) return "正在更新";
  const updated = new Date(value);
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Vancouver",
  }).format(updated);

  return `上次更新 ${time}`;
}

function renderDate() {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  document.querySelector("#todayLabel").textContent = formatter.format(new Date());
}

function getPlayCondition(maxTemp, wind, rain) {
  if (rain >= 55) return "雨高";
  if (wind >= 28) return "风大";
  if (maxTemp < 7 || maxTemp > 31) return "看体感";
  return "适合";
}

function findEveningWeather(hourly, dateISO) {
  const preferredHours = ["20:00", "21:00", "19:00"];
  const index = preferredHours
    .map((hour) => hourly.time.findIndex((time) => time === `${dateISO}T${hour}`))
    .find((itemIndex) => itemIndex >= 0);

  return index >= 0 ? index : -1;
}

function renderForecastSkeleton() {
  forecastGrid.innerHTML = getWeekDays()
    .map(
      (day) => `
        <article class="forecast-card loading">
          <span>${day.weekday}</span>
          <strong>${day.label}</strong>
          <div class="forecast-icon">☀</div>
          <p>读取中...</p>
        </article>
      `,
    )
    .join("");
}

function parseSlotRange(value) {
  const match = String(value || "").match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, startHour, startMinute, endHour, endMinute] = match.map(Number);
  return {
    start: startHour * 60 + startMinute,
    end: endHour * 60 + endMinute,
  };
}

function formatMinutes(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function mergeTimeRanges(times) {
  const ranges = times
    .map(parseSlotRange)
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  return merged.map((range) => `${formatMinutes(range.start)}-${formatMinutes(range.end)}`);
}

function hasOverlap(range, window) {
  return range.end > window.start && range.start < window.end;
}

function renderWindowedSlots(slots, hrefForSlot, windows) {
  if (!slots.length) {
    return `
      <div class="time-slot-card empty-slot">
        <strong>暂无空场</strong>
      </div>
    `;
  }

  const groups = windows.map((window) => ({
    label: `${formatMinutes(window.start)}-${formatMinutes(window.end)}`,
    courts: new Map(),
  }));

  for (const slot of slots) {
    const range = parseSlotRange(slot.time);
    if (!range) continue;

    for (const group of groups) {
      const [startLabel, endLabel] = group.label.split("-");
      const window = {
        start: parseSlotRange(`${startLabel}-${endLabel}`)?.start,
        end: parseSlotRange(`${startLabel}-${endLabel}`)?.end,
      };
      if (window.start === undefined || !hasOverlap(range, window)) continue;
      group.courts.set(String(slot.court), hrefForSlot(slot));
    }
  }

  const visibleGroups = groups.filter((group) => group.courts.size > 0);
  if (!visibleGroups.length) {
    return `
      <div class="time-slot-card empty-slot">
        <strong>暂无空场</strong>
      </div>
    `;
  }

  return visibleGroups
    .map(
      (group) => `
        <article class="time-slot-card">
          <strong>${group.label} available</strong>
          <div class="court-chip-row">
            ${Array.from(group.courts.entries())
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(
                ([court, href]) => `
                  <a class="court-chip" href="${href}" target="_blank" rel="noreferrer">
                    ${court}号场
                  </a>
                `,
              )
              .join("")}
          </div>
        </article>
      `,
    )
    .join("");
}

function renderGroupedSlots(slots, hrefForSlot) {
  if (!slots.length) {
    return `
      <div class="time-slot-card empty-slot">
        <strong>暂无空场</strong>
      </div>
    `;
  }

  const groups = new Map();
  for (const slot of slots) {
    const court = String(slot.court);
    const group = groups.get(court) ?? {
      court,
      href: hrefForSlot(slot),
      times: [],
    };
    group.times.push(slot.time);
    groups.set(court, group);
  }

  const patternGroups = new Map();
  for (const courtGroup of groups.values()) {
    const ranges = mergeTimeRanges(courtGroup.times);
    const key = ranges.join(", ");
    const patternGroup = patternGroups.get(key) ?? {
      ranges,
      courts: [],
    };
    patternGroup.courts.push({
      court: courtGroup.court,
      href: courtGroup.href,
    });
    patternGroups.set(key, patternGroup);
  }

  return Array.from(patternGroups.values())
    .sort((a, b) => a.ranges[0].localeCompare(b.ranges[0]))
    .map(
      (group) => `
        <article class="time-slot-card">
          <strong>${group.ranges.join(", ")} available</strong>
          <div class="court-chip-row">
            ${group.courts
              .sort((a, b) => Number(a.court) - Number(b.court))
              .map(
                (court) => `
                  <a class="court-chip" href="${court.href}" target="_blank" rel="noreferrer">
                    ${court.court}号场
                  </a>
                `,
              )
              .join("")}
          </div>
        </article>
      `,
    )
    .join("");
}

async function loadWeather() {
  renderForecastSkeleton();

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: richmond.latitude,
    longitude: richmond.longitude,
    hourly: "temperature_2m,weather_code,precipitation_probability,wind_speed_10m",
    timezone: "America/Vancouver",
    forecast_days: "7",
  });

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Weather request failed");
    const data = await response.json();
    const days = getWeekDays();

    forecastGrid.innerHTML = days
      .map((day) => {
        const index = findEveningWeather(data.hourly, day.iso);
        if (index < 0) throw new Error("Evening weather not found");

        const code = data.hourly.weather_code[index];
        const [summary, icon] = weatherCodes[code] ?? ["天气", "🎾"];
        const temperature = Math.round(data.hourly.temperature_2m[index]);
        const rain = data.hourly.precipitation_probability[index] ?? 0;
        const wind = Math.round(data.hourly.wind_speed_10m[index] ?? 0);
        const condition = getPlayCondition(temperature, wind, rain);

        return `
          <article class="forecast-card">
            <span>${day.weekday}</span>
            <strong>${day.label}</strong>
            <div class="forecast-icon" aria-hidden="true">${icon}</div>
            <p>20:00 ${summary}</p>
            <div class="forecast-temp">${temperature}°</div>
            <div class="mini-metrics">
              <span>雨 ${rain}%</span>
              <span>风 ${wind}</span>
              <b>${condition}</b>
            </div>
          </article>
        `;
      })
      .join("");
  } catch {
    forecastGrid.innerHTML = getWeekDays()
      .map(
        (day) => `
          <article class="forecast-card">
            <span>${day.weekday}</span>
            <strong>${day.label}</strong>
            <div class="forecast-icon" aria-hidden="true">🌤</div>
            <p>天气暂不可用</p>
            <div class="forecast-temp">--° / --°</div>
            <div class="mini-metrics">
              <span>雨 --%</span>
              <span>风 --</span>
              <b>待刷新</b>
            </div>
          </article>
        `,
      )
      .join("");
  }
}

function renderAvailability() {
  const days = getWeekDays();

  availabilityOverview.innerHTML = days
    .map((day) => {
      const liveTbc = liveAvailability.tbc[day.iso] ?? [];
      const hasLiveTbc = liveTbc.length > 0;
      const hasUbc = getUbcSlotsForDay(day).length > 0;

      return `
        <div class="overview-day">
          <span>${day.weekday}</span>
          <strong>${day.label}</strong>
          <div class="overview-dots">
            <span class="overview-dot ${hasLiveTbc ? "on" : ""}" style="--dot: var(--green)" title="Tennis Hub"></span>
            <span class="overview-dot ${hasUbc ? "on" : ""}" style="--dot: var(--blue)" title="UBC"></span>
          </div>
        </div>
      `;
    })
    .join("");

  weekList.innerHTML = days
    .map((day) => {
      const tbcCourt = courts.find((court) => court.id === "tbc");
      const courtWindow = getCourtWindow(day);
      const tbcSlots = liveAvailability.tbc[day.iso] ?? tbcEveningAvailability[day.iso] ?? tbcEveningAvailability.default;
      const tbcSlotList = renderGroupedSlots(
        tbcSlots,
        () => tbcCourt.bookingUrlForDate(day.iso),
      );
      const ubcSlots = renderGroupedSlots(
        getUbcSlotsForDay(day),
        (slot) => slot.href || getUbcCourtUrl(slot.court, day.iso),
      );
      const ubcSlotList = isWeekend(day.date)
        ? renderWindowedSlots(
            getUbcSlotsForDay(day),
            (slot) => slot.href || getUbcCourtUrl(slot.court, day.iso),
            [
              { start: 14 * 60, end: 16 * 60 },
              { start: 16 * 60, end: 18 * 60 },
              { start: 18 * 60, end: 20 * 60 },
              { start: 20 * 60, end: 22 * 60 },
              { start: 22 * 60, end: 23 * 60 },
            ],
          )
        : ubcSlots;

      return `
        <article class="day-row">
          <div class="day-label">
            <span>${day.weekday}</span>
            <strong>${day.label}</strong>
            <small>${courtWindow.label}</small>
          </div>
          <div class="court-groups">
            <div class="ubc-slots">
              <div class="slot-heading">
                <span class="court-dot" style="background:${tbcCourt.color}"></span>
                <strong>Tennis Hub</strong>
              </div>
              <div class="slot-grid">${tbcSlotList}</div>
            </div>
            <div class="ubc-slots">
              <div class="slot-heading">
                <span class="court-dot" style="background:var(--blue)"></span>
                <strong>UBC</strong>
              </div>
              <div class="slot-grid">${ubcSlotList}</div>
            </div>
          </div>
        </article>
      `;
    })
    .join("");
}

function scheduleAvailabilityFollowUp(requestId) {
  window.clearTimeout(availabilityPollTimer);
  availabilityPollTimer = window.setTimeout(() => {
    loadAvailability({ followUp: true, requestId });
  }, refreshPollMs);
}

async function fetchAvailabilityData(refresh, followUp) {
  const path = `/api/availability?${refresh && !followUp ? "refresh=1&" : ""}ts=${Date.now()}`;
  const urls =
    location.protocol === "file:"
      ? [`${productionOrigin}${path}`]
      : [...new Set([path, `${productionOrigin}${path}`])];
  let lastError;

  for (const url of urls) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error("Availability API failed");
      return response.json();
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

async function loadAvailability({ refresh = false, followUp = false, requestId = null } = {}) {
  const currentRequestId = requestId ?? ++availabilityRequestId;
  if (!followUp) {
    window.clearTimeout(availabilityPollTimer);
  }
  if (!liveAvailability.updatedAt) {
    availabilityStatus.textContent = refresh ? "正在更新..." : "读取中...";
  }
  refreshButton.disabled = true;
  try {
    liveAvailability = await fetchAvailabilityData(refresh, followUp);
    availabilityStatus.textContent = formatUpdatedAt(liveAvailability.updatedAt);

    if (liveAvailability.refreshing && currentRequestId === availabilityRequestId) {
      scheduleAvailabilityFollowUp(currentRequestId);
    } else if (currentRequestId === availabilityRequestId) {
      window.clearTimeout(availabilityPollTimer);
    }
  } catch {
    liveAvailability = { updatedAt: null, tbc: {}, ubc: {} };
    availabilityStatus.textContent = "实时读取失败，点官网确认";
  } finally {
    refreshButton.disabled = false;
  }

  renderAvailability();
}

refreshButton.addEventListener("click", () => {
  loadAvailability({ refresh: true });
  loadWeather();
});

renderDate();
loadAvailability({ refresh: true });
loadWeather();

window.setInterval(() => {
  loadAvailability({ refresh: true });
  loadWeather();
}, autoRefreshMs);
