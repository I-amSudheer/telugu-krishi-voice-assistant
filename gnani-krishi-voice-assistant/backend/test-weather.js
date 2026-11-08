const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, ".env") });

async function fetchLiveWeather(city) {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key || !city) return null;
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)},IN&appid=${key}&units=metric&lang=te`;
    console.log(`Fetching weather for: ${city}`);
    const res = await fetch(url);
    if (!res.ok) {
        console.log(`Failed: ${res.status} ${res.statusText}`);
        return null;
    }
    const j = await res.json();
    return j;
  } catch (err) {
    console.log("Error:", err.message);
    return null;
  }
}

async function test() {
    const weather = await fetchLiveWeather("Guntur");
    console.log("Weather for Guntur:", JSON.stringify(weather, null, 2));
}

test();
