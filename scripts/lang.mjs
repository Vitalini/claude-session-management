// Language presets: the kickoff phrases handed to claude when a session is
// (re)opened for a ticket, the watchdog nudge, and the label used in the
// rendered commands/skill ("write the summary in <summaryLanguage>").
// `{url}` is replaced with the ticket link, or with the bare key when Jira is
// not configured.
//
// `tabRule` is appended to the kickoff of a brand-new ticket session. It stays
// one line: the full naming rules live in ~/.claude/tab-naming.md (installed
// from templates/tab-naming.md), so the session's first message is not flooded.

// An instruction to Claude, not the user's own words — English in every
// preset; only the phrases above are localized.
const TAB_RULE = "Name this tab per ~/.claude/tab-naming.md — silently, do not mention it in your reply.";

export const LANGS = {
  en: {
    summaryLanguage: "English",
    phrases: {
      scoping: "look at the scoping {url}",
      task: "look at the task {url}",
      updates: "check what changed on {url}",
    },
    nudge: "Continue from where you left off.",
    tabRule: TAB_RULE,
  },
  ru: {
    summaryLanguage: "Russian",
    phrases: {
      scoping: "посмотри скоупинг {url}",
      task: "посмотри задачу {url}",
      updates: "посмотри обновления {url}",
    },
    nudge: "Продолжай с того места, где остановился.",
    tabRule: TAB_RULE,
  },
  uk: {
    summaryLanguage: "Ukrainian",
    phrases: {
      scoping: "подивись скоупінг {url}",
      task: "подивись задачу {url}",
      updates: "подивись оновлення {url}",
    },
    nudge: "Продовжуй з того місця, де зупинився.",
    tabRule: TAB_RULE,
  },
};

export const LANG_CODES = Object.keys(LANGS);

export function langPreset(code) {
  return LANGS[code] ?? LANGS.en;
}
