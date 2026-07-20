/*
 * i18n.js — tiny dictionary-based translator. Adding a language means
 * dropping a new ./i18n/<code>.json file and adding one line to LANGS;
 * nothing else in the app needs to change.
 */

export const LANGS = [
  { code: 'en', label: 'EN' },
  { code: 'pt', label: 'PT' },
];

const STORAGE_KEY = 'proximo_lang';
const FALLBACK = 'en';

let dict = {};
let lang = FALLBACK;

function isSupported(code) {
  return LANGS.some((l) => l.code === code);
}

function detectDefault() {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored && isSupported(stored)) return stored;
  const nav = (navigator.language || '').slice(0, 2).toLowerCase();
  return isSupported(nav) ? nav : FALLBACK;
}

export async function initI18n(preferred) {
  lang = preferred && isSupported(preferred) ? preferred : detectDefault();
  try {
    const res = await fetch(`./i18n/${lang}.json`);
    dict = res.ok ? await res.json() : {};
  } catch (err) {
    console.error('i18n load failed:', err);
    dict = {};
  }
  document.documentElement.lang = lang;
  applyStaticTranslations();
}

export async function setLang(newLang) {
  if (!isSupported(newLang) || newLang === lang) return;
  localStorage.setItem(STORAGE_KEY, newLang);
  await initI18n(newLang);
}

export function getLang() {
  return lang;
}

export function t(key, vars) {
  let str = dict[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{{${k}}}`, v);
  }
  return str;
}

function applyStaticTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach((el) => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
}
