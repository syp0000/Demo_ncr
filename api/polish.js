export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { requireAppPassword } = await import('../lib/auth.js');
  if (!requireAppPassword(req, res)) return;

  const { text, field, lang } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const langInstruction = {
    ko: 'Write in Korean only. If the input is English, translate it to Korean. Keep technical terms such as SPD, EOL, NG, DC, and BPU as-is.',
    en: 'Write in English only. If the input is in Korean, translate it to English. Keep all technical terms as-is.',
    mix: 'Use Korean for general wording and English for technical terms or part names.'
  }[lang] || 'Write in Korean only.';

  const fieldLabel = field === 'issue' ? 'Issue or symptom' : 'Action taken';
  if (!process.env.ANTHROPIC_API_KEY) {
    const { buildDemoPolish } = await import('../lib/demo-polish.js');
    return res.status(200).json({ polished: buildDemoPolish({ text, field, lang }), demo: true });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: `You are a manufacturing quality control report assistant for an EV battery pack assembly line.
Polish technician field report entries to be concise and professional.
Rules:
- Fix grammar and awkward phrasing
- Use report style (not conversational)
- Keep technical terms exactly as-is (SPD, EOL, NG, DC, OQC, BPU, etc.)
- ${langInstruction}
- Output ONLY the polished text. No explanation, no quotes, no prefix.`,
        messages: [{
          role: 'user',
          content: `Field: ${fieldLabel}\nRaw input: "${text}"\nPolished output:`
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      const apiErr = data?.error?.message || JSON.stringify(data);
      throw new Error(`Anthropic API error ${response.status}: ${apiErr}`);
    }
    const polished = data.content?.[0]?.text?.trim();
    if (!polished) throw new Error('Empty response from model');

    res.status(200).json({ polished });
  } catch (err) {
    console.error('[polish]', err.message);
    res.status(500).json({ error: 'Polish failed', detail: err.message });
  }
}
