const path = require('path');
const fs = require('fs');

function listsFile(lang) {
  return path.join(__dirname, lang === 'de' ? 'lists-de.json' : 'lists.json');
}

function loadLists(lang) {
  try {
    return JSON.parse(fs.readFileSync(listsFile(lang), 'utf8'));
  } catch {
    return { businesses: [], products: [], themes: [] };
  }
}

function saveLists(data, lang) {
  fs.writeFileSync(listsFile(lang), JSON.stringify(data, null, 2));
}

function pickPrompt(usedSet, lang) {
  const { businesses, products, themes = [] } = loadLists(lang);
  const useTheme = themes.length > 0 && Math.random() < 0.2;
  const pool = useTheme ? themes : products;

  let b, second, key, attempts = 0;
  do {
    b = businesses[Math.floor(Math.random() * businesses.length)];
    second = pool[Math.floor(Math.random() * pool.length)];
    key = `${useTheme ? 't' : 'p'}|${b}|${second}`;
    attempts++;
  } while (usedSet.has(key) && attempts < 200);
  usedSet.add(key);

  if (lang === 'de') {
    if (useTheme) {
      return { type: 'theme', business: b, theme: second, text: `${second}-${b}`, lang: 'de' };
    }
    return { type: 'product', business: b, product: second, text: `Ein ${b}, der auch ${second} verkauft`, lang: 'de' };
  }
  if (useTheme) {
    return { type: 'theme', business: b, theme: second, text: `A ${second}-themed ${b}` };
  }
  return { type: 'product', business: b, product: second, text: `A ${b} that also sells ${second}` };
}

module.exports = { listsFile, loadLists, saveLists, pickPrompt };
