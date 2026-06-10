const richmond = { latitude: 49.1666, longitude: -123.1336 };

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

function formatLocalISO(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function getWeekDays() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index);
    const iso = formatLocalISO(date);
    const weekday = new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date);
    const label = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric" }).format(date);

    return {
      iso,
      weekday,
      label,
      ubcOpen: index <= 1,
      tbcUrl: `https://clubspark.ca/tbchubrichmond/Booking/BookByDate#?date=${iso}&role=guest`,
      ubcUrl: "https://recreation.ubc.ca/tennis/court-booking/",
    };
  });
}

function getPlayCondition(maxTemp, wind, rain) {
  if (rain >= 55) return "雨高";
  if (wind >= 28) return "风大";
  if (maxTemp < 7 || maxTemp > 31) return "看体感";
  return "适合";
}

Page({
  data: {
    weekDays: getWeekDays(),
    forecast: getWeekDays().map((day) => ({
      ...day,
      icon: "☀",
      summary: "读取中",
      high: "--",
      low: "--",
      rain: "--",
      wind: "--",
      condition: "待刷新",
    })),
  },

  onLoad() {
    this.loadWeather();
  },

  refresh() {
    this.setData({ weekDays: getWeekDays() });
    this.loadWeather();
  },

  loadWeather() {
    wx.request({
      url: "https://api.open-meteo.com/v1/forecast",
      data: {
        latitude: richmond.latitude,
        longitude: richmond.longitude,
        daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max",
        timezone: "America/Vancouver",
        forecast_days: 7,
      },
      success: (res) => {
        const daily = res.data && res.data.daily;
        if (!daily) {
          this.useFallbackForecast();
          return;
        }

        const forecast = getWeekDays().map((day, index) => {
          const code = daily.weather_code[index];
          const weather = weatherCodes[code] || ["天气", "🎾"];
          const high = Math.round(daily.temperature_2m_max[index]);
          const low = Math.round(daily.temperature_2m_min[index]);
          const rain = daily.precipitation_probability_max[index] || 0;
          const wind = Math.round(daily.wind_speed_10m_max[index] || 0);

          return {
            ...day,
            summary: weather[0],
            icon: weather[1],
            high,
            low,
            rain,
            wind,
            condition: getPlayCondition(high, wind, rain),
          };
        });

        this.setData({ forecast });
      },
      fail: () => this.useFallbackForecast(),
    });
  },

  useFallbackForecast() {
    this.setData({
      forecast: getWeekDays().map((day) => ({
        ...day,
        icon: "🌤",
        summary: "天气暂不可用",
        high: "--",
        low: "--",
        rain: "--",
        wind: "--",
        condition: "待刷新",
      })),
    });
  },

  copyBookingUrl(event) {
    const { url, name } = event.currentTarget.dataset;
    wx.setClipboardData({
      data: url,
      success: () => {
        wx.showToast({
          title: `${name} 链接已复制`,
          icon: "success",
        });
      },
    });
  },
});
