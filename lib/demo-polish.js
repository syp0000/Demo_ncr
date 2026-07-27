const TERM_REPLACEMENTS = [
  ['normal check failed', 'normal check did not pass'],
  ['ng', 'NG']
];

function cleanWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function ensureSentence(value) {
  const text = cleanWhitespace(value);
  if (!text) return '';
  return /[.!?。]$/.test(text) ? text : `${text}.`;
}

export function buildDemoPolish({ text, field, lang = 'en' }) {
  const cleaned = cleanWhitespace(text);
  if (!cleaned) return '';

  if (lang === 'ko') {
    const label = field === 'issue' ? '이상 내용' : '조치 내용';
    return `${label}: ${ensureSentence(cleaned)}`;
  }

  let polished = cleaned;
  for (const [from, to] of TERM_REPLACEMENTS) {
    polished = polished.replace(new RegExp(from, 'gi'), to);
  }

  const prefix = field === 'issue'
    ? 'Issue observed'
    : 'Action completed';
  return `${prefix}: ${ensureSentence(polished)}`;
}
