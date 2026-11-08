const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.join(__dirname, ".env") });

async function callGroqAnswer({ transcriptText, weather }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return "No Key";
  const model = process.env.GROQ_MODEL || "qwen/qwen3.8-27b";

  const weatherLine = weather
    ? `Live weather right now in ${weather.city}: ${weather.temp}°C, ${weather.desc}. Use these exact numbers; do not invent any other figures.`
    : "No live weather data is available.";

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You are రైతు నేస్తం, a Telugu farming assistant for Andhra Pradesh farmers. " +
            "Reply in simple spoken Telugu only, in 2 short sentences at most. " +
            "Answer the question directly. No bullet points, no headings, no English sentences, no long advice lists. " +
            weatherLine,
        },
        { role: "user", content: transcriptText },
      ],
      max_tokens: 160,
      temperature: 0.5,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    return `Error: ${res.status} ${body}`;
  }
  const data = await res.json();
  return data.choices[0].message.content;
}

async function test() {
    const transcriptText = "మా జిల్లా గుంటూరు, గుంటూరులో వాతావరణం ఎలా ఉంది ఈరోజు?";
    const weather = { city: "Guntur", temp: 30, desc: "light rain" };
    const reply = await callGroqAnswer({ transcriptText, weather });
    console.log("Groq Reply:", reply);
}

test();
