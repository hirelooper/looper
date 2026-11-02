// Personal mailbox providers: their domain says nothing about the owner's business, so onboarding
// asks for the website instead of reading it from the email. Shared by the login page (to suggest a
// work email) and the server (to start reading the company's site on sign-in).

const PERSONAL = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.nl",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "web.de",
  "t-online.de",
  "zoho.com",
  "yandex.ru",
  "yandex.com",
  "mail.ru",
  "hey.com",
  "fastmail.com",
  "tutanota.com",
  "qq.com",
  "163.com",
  "ziggo.nl",
  "kpnmail.nl",
  "kpnplanet.nl",
  "hetnet.nl",
  "planet.nl",
  "home.nl",
  "xs4all.nl",
  "telenet.be",
  "skynet.be",
  "orange.fr",
  "free.fr",
  "laposte.net",
  "libero.it",
  "btinternet.com",
  "sky.com",
]);

/** The domain of an email address, lowercased; "" when it isn't one. */
export const emailDomain = (email: string) => email.trim().toLowerCase().split("@")[1]?.replace(/\.$/, "") ?? "";

export const isPersonalDomain = (domain: string) => PERSONAL.has(domain) || /^(hotmail|outlook|yahoo|live)\.[a-z.]+$/.test(domain);

/** The company website an email points at (pavel@timetuna.com → timetuna.com), or null for a personal mailbox. */
export function businessDomain(email: string): string | null {
  const d = emailDomain(email);
  if (!d || !d.includes(".") || isPersonalDomain(d)) return null;
  return d;
}
