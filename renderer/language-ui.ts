import { isLanguage, translateText, type Language } from "../src/core/language";

let language: Language = "en";
const textSources = new WeakMap<Node, { source: string; rendered: string }>();
const attributeSources = new WeakMap<Element, Map<string, { source: string; rendered: string }>>();
export const localize = (text: string) => translateText(text, language);

// Keep canonical text per node so switching back to English is lossless. Dynamic
// application updates become new canonical text; chart names and diagnostics are exempt.
function excluded(element: Element | null): boolean {
  return !!element?.closest("#log, #path-bms, #path-osu, .language-switch, script, style");
}
function translateNode(node: Node): void {
  if (node.nodeType === Node.TEXT_NODE) {
    if (excluded(node.parentElement)) return;
    const current = node.textContent ?? "";
    const previous = textSources.get(node);
    const source = previous && current === previous.rendered ? previous.source : current;
    if (node.parentElement?.closest("#file-summary-bms, #file-summary-osu") && !["No BMS selected", "No osu! map selected"].includes(source)) return;
    if (node.parentElement?.closest("#difficulty-bms option[value], #difficulty-osu option[value]")) return;
    const rendered = source.replace(/\S[\s\S]*\S|\S/, text => localize(text));
    textSources.set(node, { source, rendered });
    if (current !== rendered) node.textContent = rendered;
  } else if (node instanceof Element) {
    if (excluded(node) || (node instanceof HTMLOptionElement && !!node.value && !!node.closest("#difficulty-bms, #difficulty-osu"))) return;
    let records = attributeSources.get(node);
    if (!records) { records = new Map(); attributeSources.set(node, records); }
    for (const name of ["title", "aria-label", "placeholder"]) {
      const current = node.getAttribute(name);
      if (current === null) continue;
      const previous = records.get(name);
      const source = previous && current === previous.rendered ? previous.source : current;
      const rendered = localize(source);
      records.set(name, { source, rendered });
      if (current !== rendered) node.setAttribute(name, rendered);
    }
    for (const child of Array.from(node.childNodes)) translateNode(child);
  }
}

export function initializeLanguageUi(redraw: () => void): void {
  try { const saved = localStorage.getItem("bms2osu-language"); if (isLanguage(saved)) language = saved; } catch {}
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "childList") for (const node of Array.from(record.addedNodes)) translateNode(node);
      else translateNode(record.target);
    }
  });
  const observe = () => observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "aria-label", "placeholder"] });
  const apply = () => {
    observer.disconnect();
    document.documentElement.lang = language === "zh" ? "zh-CN" : language;
    document.querySelectorAll<HTMLButtonElement>("[data-language]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.language === language)));
    redraw();
    translateNode(document.body);
    try { localStorage.setItem("bms2osu-language", language); } catch {}
    window.bms2osu.setLanguage?.(language).catch(() => {});
    observe();
  };
  document.querySelectorAll<HTMLButtonElement>("[data-language]").forEach(button => button.addEventListener("click", () => {
    if (isLanguage(button.dataset.language)) { language = button.dataset.language; apply(); }
  }));
  apply();
}
