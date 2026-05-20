export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Password');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { requireAppPassword } = await import('../lib/auth.js');
  if (!requireAppPassword(req, res)) return;

  const { text, field } = req.body;
  if (!text) return res.status(400).json({ error: 'No text provided' });

  const fieldLabel = field === 'issue' ? 'Issue / Abnormality' : 'Action Taken';
  if (!process.env.ANTHROPIC_API_KEY) {
    const { buildDemoPolish } = await import('../lib/demo-polish.js');
    return res.status(200).json({ polished: buildDemoPolish({ text, field, lang: 'en' }), demo: true });
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
        system: `You are an English-language quality control report assistant for an EV battery pack assembly line.
Your job: rewrite the input as a concise, professional English report entry.
- Output must be in English only, regardless of the input language. If input is Korean, translate it to English.
- Keep technical terms exactly as-is: SPD, EOL, NG, DC, OQC, BPU, etc.
- Use formal report style (not conversational).
- Fix grammar and awkward phrasing.
- Output ONLY the rewritten text. No explanation, no quotes, no labels.`,
        messages: [{
          role: 'user',
          content: `Field: ${fieldLabel}\nInput: "${text}"\nEnglish output:`
        }]
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(`Anthropic API error ${response.status}: ${data?.error?.message || JSON.stringify(data)}`);
    }
    const polished = data.content?.[0]?.text?.trim();
    if (!polished) throw new Error('Empty response from model');

    res.status(200).json({ polished });
  } catch (err) {
    console.error('[polish-en]', err.message);
    res.status(500).json({ error: 'Polish failed', detail: err.message });
  }
}
