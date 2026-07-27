import { buildDemoPolish } from '../lib/demo-polish.js';
import { route } from '../lib/http.js';

const MODEL = 'claude-haiku-4-5-20251001';

// One entry per supported output language. `lang` on the request picks the entry;
// anything unrecognised falls back to Korean, which is what the shop floor writes in.
const LANGUAGES = {
  ko: {
    system: `You are a Korean-language quality control report assistant for an EV battery pack assembly line.
Your job: rewrite the input as a concise, professional Korean report entry.
- Output must be in Korean only, regardless of the input language. If input is English, translate it to Korean.
- Keep technical terms exactly as-is: SPD, EOL, NG, DC, OQC, BPU, etc.
- Use formal report style (not conversational).
- Fix grammar and awkward phrasing.
- Output ONLY the rewritten text. No explanation, no quotes, no labels.`,
    fieldLabels: { issue: 'Issue or symptom', action: 'Action taken' },
    outputLabel: 'Korean output'
  },
  en: {
    system: `You are an English-language quality control report assistant for an EV battery pack assembly line.
Your job: rewrite the input as a concise, professional English report entry.
- Output must be in English only, regardless of the input language. If input is Korean, translate it to English.
- Keep technical terms exactly as-is: SPD, EOL, NG, DC, OQC, BPU, etc.
- Use formal report style (not conversational).
- Fix grammar and awkward phrasing.
- Output ONLY the rewritten text. No explanation, no quotes, no labels.`,
    fieldLabels: { issue: 'Issue / Abnormality', action: 'Action Taken' },
    outputLabel: 'English output'
  }
};

async function askClaude({ system, prompt }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 200,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${data?.error?.message || JSON.stringify(data)}`);
  }
  const polished = data.content?.[0]?.text?.trim();
  if (!polished) throw new Error('Empty response from model');
  return polished;
}

export default route(
  { name: 'polish', methods: ['POST'], headers: ['X-User-Token'] },
  async (req, res) => {
    const { text, field } = req.body || {};
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const lang = LANGUAGES[req.body?.lang] ? req.body.lang : 'ko';
    const config = LANGUAGES[lang];

    // No API key means this is a public demo deployment: hand back a marked stub
    // so the polish buttons still do something visible.
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(200).json({ polished: buildDemoPolish({ text, field, lang }), demo: true });
    }

    const fieldLabel = config.fieldLabels[field === 'issue' ? 'issue' : 'action'];
    const polished = await askClaude({
      system: config.system,
      prompt: `Field: ${fieldLabel}\nInput: "${text}"\n${config.outputLabel}:`
    });
    return res.status(200).json({ polished });
  }
);
