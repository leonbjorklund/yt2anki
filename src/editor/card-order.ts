import { chineseSegmentField } from "../domain/language.ts";
import type { Draft } from "../domain/types.ts";

export function createCardOrderControls({
  draft,
  target,
  translation,
  pinyinField,
  onChange,
}: {
  draft: Draft;
  target: HTMLTextAreaElement;
  translation: HTMLTextAreaElement;
  pinyinField: HTMLElement;
  onChange: () => void;
}): { setDisabled: (disabled: boolean) => void } {
  const targetLabel = target.closest("label");
  const translationLabel = translation.closest("label");
  const container = targetLabel?.parentElement;
  if (!container || !targetLabel || !translationLabel) {
    throw new Error("Card preview language fields are missing.");
  }
  let disabled = false;
  const groups = [targetLabel, translationLabel].map((label, index) => {
    const group = document.createElement("div");
    group.className = "preview-language";
    group.dataset.language = index === 0 ? "target" : "translation";
    group.hidden = index === 1 && !draft.translationTrack;
    const row = document.createElement("div");
    row.className = "preview-language-row";
    const actions = document.createElement("div");
    actions.className = "field-order-actions";
    actions.hidden = !draft.translationTrack;
    const name = label.querySelector("span")?.textContent ?? "Language";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ghost-button";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", "M8 19V5m-4 4 4-4 4 4m4-4v14m-4-4 4 4 4-4");
    svg.append(path);
    button.append(svg);
    button.addEventListener("click", () => {
      if (disabled || !draft.translationTrack) return;
      draft.translationFirst = !draft.translationFirst;
      render();
      button.focus();
      onChange();
    });
    actions.append(button);
    row.append(label, actions);
    group.append(row);
    return { group, button, name };
  });
  const chinese = chineseSegmentField(
    draft.targetTrack,
    draft.translationTrack,
  );
  groups[chinese === "translation" ? 1 : 0]?.group.append(pinyinField);

  function render(): void {
    const order = draft.translationFirst ? [1, 0] : [0, 1];
    for (const index of order) {
      const entry = groups[index];
      if (!entry) continue;
      container?.append(entry.group);
      const direction = index === order[0] ? "down" : "up";
      entry.button.disabled = disabled;
      entry.button.setAttribute(
        "aria-label",
        `Move ${entry.name} ${direction}`,
      );
      entry.button.title = `Move ${entry.name} ${direction} on every card`;
    }
  }
  render();
  return {
    setDisabled(value) {
      disabled = value;
      render();
    },
  };
}
