// Language presets: the kickoff phrases handed to claude when a session is
// (re)opened for a ticket, the watchdog nudge, and the label used in the
// rendered commands/skill ("write the summary in <summaryLanguage>").
// `{url}` is replaced with the ticket link, or with the bare key when Jira is
// not configured.

// How to rename the tab from inside the session. Shared by all languages: the
// tab title is what search, the dashboard and `sm` key off, so a fresh ticket
// session must name its tab before doing anything else. Targets the CALLER
// tab explicitly — a bare `cmux rename-tab` renames whichever tab is focused.
const RENAME_SNIPPET = `TITLE="<title>"
CALLER_TAB=$(cmux identify 2>/dev/null | python3 -c "import json,sys; print(json.load(sys.stdin)['caller']['tab_ref'])")
[ -n "$CALLER_TAB" ] && cmux rename-tab --tab "$CALLER_TAB" "$TITLE"`;

export const LANGS = {
  en: {
    summaryLanguage: "English",
    phrases: {
      scoping: "look at the scoping {url}",
      task: "look at the task {url}",
      updates: "check what changed on {url}",
    },
    nudge: "Continue from where you left off.",
    tabRule: `First, once you have read the ticket, rename this terminal tab so the session is identifiable at a glance. Title format:

[<TICKET-KEY>][<Client or project>] - <Shortened ticket title>

- <Client or project>: the short brand/project name from the ticket, not the full legal or site name.
- <Shortened ticket title>: 2–4 words in the ticket's own vocabulary; drop the client name (already in the title), articles and filler.
- Keep the whole title under ~40 characters — tabs are narrow and clip the end. Cut words from the title, never the key.
- Example: [PROJ-123][Nuts.com] - Auto-apply coupon

Run this block as one unit:

${RENAME_SNIPPET}`,
  },
  ru: {
    summaryLanguage: "Russian",
    phrases: {
      scoping: "посмотри скоупинг {url}",
      task: "посмотри задачу {url}",
      updates: "посмотри обновления {url}",
    },
    nudge: "Продолжай с того места, где остановился.",
    tabRule: `Сначала, как только прочитаешь задачу, переименуй этот таб терминала, чтобы сессию было видно с одного взгляда. Формат названия:

[<КЛЮЧ-ЗАДАЧИ>][<Клиент или проект>] - <Короткое название задачи>

- <Клиент или проект>: короткое имя бренда/проекта из задачи, не полное юридическое название и не домен.
- <Короткое название задачи>: 2–4 слова словами самой задачи; без имени клиента (оно уже в названии), без артиклей и воды.
- Всё название — до ~40 символов: табы узкие и обрезают конец. Сокращай название, но не ключ.
- Пример: [PROJ-123][Nuts.com] - Auto-apply coupon

Выполни этот блок целиком:

${RENAME_SNIPPET}`,
  },
  uk: {
    summaryLanguage: "Ukrainian",
    phrases: {
      scoping: "подивись скоупінг {url}",
      task: "подивись задачу {url}",
      updates: "подивись оновлення {url}",
    },
    nudge: "Продовжуй з того місця, де зупинився.",
    tabRule: `Спочатку, щойно прочитаєш задачу, перейменуй цей таб терміналу, щоб сесію було видно з першого погляду. Формат назви:

[<КЛЮЧ-ЗАДАЧІ>][<Клієнт або проєкт>] - <Коротка назва задачі>

- <Клієнт або проєкт>: коротке ім'я бренду/проєкту із задачі, не повна юридична назва і не домен.
- <Коротка назва задачі>: 2–4 слова словами самої задачі; без імені клієнта (воно вже в назві), без артиклів і води.
- Уся назва — до ~40 символів: таби вузькі й обрізають кінець. Скорочуй назву, але не ключ.
- Приклад: [PROJ-123][Nuts.com] - Auto-apply coupon

Виконай цей блок цілком:

${RENAME_SNIPPET}`,
  },
};

export const LANG_CODES = Object.keys(LANGS);

export function langPreset(code) {
  return LANGS[code] ?? LANGS.en;
}
