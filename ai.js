const Anthropic = require('@anthropic-ai/sdk');
const { pickPrompt } = require('./prompts');
const anthropic = new Anthropic();

const AI_SYSTEM_PROMPT = {
  en: 'You are playing a party game called "Branded" (in the style of Quiplash). ' +
      'You will be given a prompt describing a business, e.g. "A butcher that also sells kayaks" ' +
      'or "Goth-themed bakery". Reply with a short, funny submission — a business name, slogan, ' +
      'or pun — under 100 characters. Reply with ONLY the submission text, no quotes, no explanation.',
  de: 'Du spielst ein Partyspiel namens "Branded" (im Stil von Quiplash). ' +
      'Du bekommst eine Aufgabe, die ein Unternehmen beschreibt, z.B. "Ein Metzger, der auch Kajaks verkauft" ' +
      'oder "Goth-Bäckerei". Antworte mit einem kurzen, witzigen Vorschlag — ein Firmenname, Slogan ' +
      'oder Wortspiel — unter 100 Zeichen. Antworte NUR mit dem Vorschlag, ohne Anführungszeichen, ohne Erklärung.'
};

const AI_FALLBACK_ANSWERS = {
  en: ['Absolutely Cursed Inc.', 'Just Add Puns', 'We Deliver... Something', 'No Refunds, Only Vibes'],
  de: ['Einfach Mal Machen GmbH', 'Fragen Sie Nicht Warum', 'Irgendwas Mit Herz', 'Keine Rückgabe, Nur Vibes']
};

async function generateAiAnswer(promptText, lang, model) {
  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: 60,
      system: AI_SYSTEM_PROMPT[lang] || AI_SYSTEM_PROMPT.en,
      messages: [{ role: 'user', content: promptText }]
    });
    if (response.stop_reason === 'refusal') throw new Error('refusal');
    const block = response.content.find(b => b.type === 'text');
    const text = block?.text?.trim().replace(/^"(.*)"$/, '$1');
    if (!text) throw new Error('empty response');
    return text.slice(0, 100);
  } catch (err) {
    console.error('AI answer generation failed:', err.message);
    const pool = AI_FALLBACK_ANSWERS[lang] || AI_FALLBACK_ANSWERS.en;
    return pool[Math.floor(Math.random() * pool.length)];
  }
}

const GRAMMAR_CHECK_MODEL = 'claude-haiku-4-5';

const GRAMMAR_SYSTEM_PROMPT =
  'You are a German grammar checker for a short party-game prompt. You will receive a short German phrase ' +
  'describing a business combined with a product or theme, e.g. "Ein Abnehmprogramm, der auch Haifischzähne ' +
  'verkauft" or "Piraten-Bäckerei". Check it for grammatical errors — especially article/gender agreement ' +
  '(der/die/das, ein/eine), noun cases, and compound-word hyphenation. Reply with ONLY the corrected phrase, ' +
  'preserving the original meaning, business, and product/theme exactly — just fix the grammar. If it is ' +
  'already correct, reply with it completely unchanged. No quotes, no explanation.';

async function checkGermanGrammar(text) {
  try {
    const response = await anthropic.messages.create({
      model: GRAMMAR_CHECK_MODEL,
      max_tokens: 80,
      temperature: 0, // correction, not creativity — favor consistency
      system: GRAMMAR_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }]
    });
    if (response.stop_reason === 'refusal') throw new Error('refusal');
    const block = response.content.find(b => b.type === 'text');
    const corrected = block?.text?.trim().replace(/^"(.*)"$/, '$1');
    if (!corrected) throw new Error('empty response');
    return corrected.slice(0, 150);
  } catch (err) {
    console.error('German grammar check failed, using original text:', err.message);
    return text;
  }
}

// Shared by the live game and Daily Mode: picks a prompt, then runs it through
// the grammar checker when German (the English template needs no correction).
async function pickCheckedPrompt(usedSet, lang) {
  const prompt = pickPrompt(usedSet, lang);
  if (lang === 'de') {
    prompt.text = await checkGermanGrammar(prompt.text);
  }
  return prompt;
}

module.exports = { generateAiAnswer, checkGermanGrammar, pickCheckedPrompt };
