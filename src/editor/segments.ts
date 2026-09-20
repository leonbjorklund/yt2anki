import { chineseSegmentField } from "../domain/language.ts";
import { mergeSegments, revertSegment } from "../domain/merge.ts";
import { fillBlankPinyin } from "../domain/pinyin.ts";
import type { Draft, Segment } from "../domain/types.ts";
import { createCardOrderControls } from "./card-order.ts";

interface SegmentEditorOptions {
  bulkSelection: HTMLInputElement;
  draft: Draft;
  generatePinyin: HTMLButtonElement;
  list: HTMLTableSectionElement;
  mergeStatus: HTMLElement;
  onMergeBusy: (busy: boolean) => void;
  onMergeError: (message: string) => void;
  onChange: () => void;
  onPreview: (segment: Segment, index: number) => void;
  onSelect: (segment: Segment, index: number) => void;
  pinyinHeading: HTMLTableCellElement;
  pinyinStatus: HTMLElement;
  previewPinyin: HTMLTextAreaElement;
  previewPinyinField: HTMLElement;
  previewTarget: HTMLTextAreaElement;
  previewTranslation: HTMLTextAreaElement;
  summary: HTMLElement;
  translationHeading: HTMLTableCellElement;
}

export interface SegmentEditor {
  render: () => void;
  selectedSegments: () => Segment[];
  setDisabled: (disabled: boolean) => void;
}

export function createSegmentEditor({
  bulkSelection,
  draft,
  generatePinyin,
  list,
  mergeStatus,
  onMergeBusy,
  onMergeError,
  onChange,
  onPreview,
  onSelect,
  pinyinHeading,
  pinyinStatus,
  previewPinyin,
  previewPinyinField,
  previewTarget,
  previewTranslation,
  summary,
  translationHeading,
}: SegmentEditorOptions): SegmentEditor {
  const cardOrder = createCardOrderControls({
    draft,
    target: previewTarget,
    translation: previewTranslation,
    pinyinField: previewPinyinField,
    onChange,
  });
  let activeIndex = 0;
  let disabled = false;
  let merging = false;
  const pinyinSource = chineseSegmentField(
    draft.targetTrack,
    draft.translationTrack,
  );
  // Gated on the track, not just on stored values: the Note Type follows the
  // track, so a Draft with no Pinyin source would otherwise show an editable
  // column whose contents the package silently drops.
  let pinyinVisible =
    pinyinSource !== null &&
    draft.segments.some((segment) => Boolean(segment.pinyin.trim()));

  list.addEventListener("click", (event) => {
    if (disabled || merging) return;
    const target = event.target as Element;
    const row = target.closest<HTMLTableRowElement>(".segment-row");
    if (!row) {
      return;
    }
    const index = Number(row.dataset.index);
    if (!draft.segments[index]) {
      return;
    }
    if (target.closest(".merge-boundary")) {
      void mergeAt(index);
      return;
    }
    if (target.closest(".revert-merge")) {
      const sources = revertSegment(draft.segments[index]);
      if (sources) {
        replaceSegments(index, 1, sources);
        mergeStatus.textContent = "Last merge reverted.";
      }
      return;
    }
    setActive(index);
    if (!target.closest('input[type="checkbox"]')) {
      onPreview(draft.segments[index], index);
    }
  });

  async function mergeAt(index: number): Promise<void> {
    const first = draft.segments[index];
    const second = draft.segments[index + 1];
    if (!first || !second) return;
    merging = true;
    onMergeBusy(true);
    applyInteractionState();
    let merged: Segment | undefined;
    try {
      merged = await mergeSegments(first, second);
    } catch {
      onMergeError("Cards could not be merged. Your rows have not changed.");
    } finally {
      merging = false;
      onMergeBusy(false);
      applyInteractionState();
    }
    // Regeneration can make this editor stale while the identity is computed.
    if (!merged || disabled) return;
    replaceSegments(index, 2, [merged]);
    mergeStatus.textContent = "Cards merged. Use Revert last merge to undo.";
  }

  function replaceSegments(
    index: number,
    count: number,
    segments: Segment[],
  ): void {
    draft.segments.splice(index, count, ...segments);
    activeIndex = index;
    render();
    const row = rowAt(index);
    (
      row?.querySelector<HTMLButtonElement>(".revert-merge") ??
      row?.querySelector<HTMLButtonElement>(".row-preview-button")
    )?.focus({ preventScroll: true });
    onChange();
  }

  list.addEventListener("focusin", (event) => {
    const target = event.target as Element;
    const row = target.closest<HTMLTableRowElement>(".segment-row");
    if (row) {
      setActive(Number(row.dataset.index));
    }
  });

  list.addEventListener("input", (event) => {
    const input = event.target as HTMLTextAreaElement;
    if (input.tagName !== "TEXTAREA") {
      return;
    }
    const index = Number(input.dataset.index);
    const segment = draft.segments[index];
    const field = input.dataset.field as EditableField | undefined;
    if (!segment || !field) {
      return;
    }
    updateField(index, field, input.value, input);
  });

  list.addEventListener("change", (event) => {
    const input = event.target as HTMLInputElement;
    if (input.type !== "checkbox") {
      return;
    }
    const index = Number(input.dataset.index);
    const segment = draft.segments[index];
    if (!segment) {
      return;
    }
    segment.selected = input.checked;
    updateRow(index);
    updateSummary();
    onChange();
  });

  bulkSelection.addEventListener("change", () => {
    for (const segment of draft.segments) {
      segment.selected = bulkSelection.checked && hasTargetText(segment);
    }
    renderSelection();
  });

  generatePinyin.addEventListener("click", () => {
    if (pinyinSource === null) {
      return;
    }
    const result = fillBlankPinyin(draft);
    pinyinVisible = true;
    pinyinStatus.textContent = `Generated Pinyin for ${result.generated} ${plural(result.generated, "Segment")}. Kept ${result.kept} existing ${plural(result.kept, "value")}.`;
    render();
    previewPinyin.focus();
    onChange();
  });

  for (const input of [previewTarget, previewPinyin, previewTranslation]) {
    input.addEventListener("input", () => {
      const segment = draft.segments[activeIndex];
      const field = input.dataset.field as EditableField | undefined;
      if (!segment || !field) {
        return;
      }
      updateField(activeIndex, field, input.value, input);
    });
  }

  previewTarget.dataset.field = "target";
  previewPinyin.dataset.field = "pinyin";
  previewTranslation.dataset.field = "translation";

  function render(): void {
    summary.parentElement?.style.setProperty(
      "--segment-count-width",
      `${String(draft.segments.length).length * 2 + 1}ch`,
    );
    translationHeading.hidden = !draft.translationTrack;
    pinyinHeading.hidden = !pinyinVisible;
    previewPinyinField.hidden = !pinyinVisible;
    const fragment = document.createDocumentFragment();
    draft.segments.forEach((segment, index) => {
      fragment.append(createRow(segment, index, pinyinVisible, draft));
    });
    list.replaceChildren(fragment);
    draft.segments.forEach((_segment, index) => {
      updateRow(index);
    });
    updateSummary();
    setActive(Math.min(activeIndex, Math.max(0, draft.segments.length - 1)));
    applyInteractionState();
  }

  function renderSelection(): void {
    draft.segments.forEach((_segment, index) => {
      updateRow(index);
    });
    updateSummary();
    onChange();
  }

  function setActive(index: number): void {
    if (!draft.segments[index]) {
      return;
    }
    const previousRow = rowAt(activeIndex);
    previousRow?.classList.remove("active");
    previousRow?.removeAttribute("aria-current");
    activeIndex = index;
    const activeRow = rowAt(activeIndex);
    activeRow?.classList.add("active");
    activeRow?.setAttribute("aria-current", "true");
    updatePreviewEditor();
    onSelect(draft.segments[index], index);
  }

  function updatePreviewEditor(): void {
    const segment = draft.segments[activeIndex];
    if (!segment) {
      return;
    }
    previewTarget.value = segment.target;
    previewPinyin.value = segment.pinyin;
    previewTranslation.value = segment.translation;
    updatePreviewValidation(segment);
  }

  function updateField(
    index: number,
    field: EditableField,
    value: string,
    source: HTMLTextAreaElement,
  ): void {
    const segment = draft.segments[index];
    if (!segment) {
      return;
    }
    segment[field] = value;
    if (field === "target" && !hasTargetText(segment)) {
      segment.selected = false;
    }
    const tableInput = rowAt(index)?.querySelector<HTMLTextAreaElement>(
      `textarea[data-field="${field}"]`,
    );
    if (tableInput && tableInput !== source) {
      tableInput.value = value;
    }
    if (index === activeIndex) {
      const previewInput = previewInputFor(field);
      if (previewInput !== source) {
        previewInput.value = value;
      }
      updatePreviewValidation(segment);
    }
    updateRow(index);
    updateSummary();
    onChange();
  }

  function updateRow(index: number): void {
    const segment = draft.segments[index];
    const row = rowAt(index);
    if (!segment || !row) {
      return;
    }
    const missingTarget = !hasTargetText(segment);
    row.classList.toggle("invalid", missingTarget);
    const checkbox = row.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    if (checkbox) {
      checkbox.checked = segment.selected;
    }
    const target = row.querySelector<HTMLTextAreaElement>(
      'textarea[data-field="target"]',
    );
    target?.setAttribute("aria-invalid", missingTarget.toString());
  }

  function updateSummary(): void {
    const selectedCount = selectedSegments().length;
    const selectableCount = draft.segments.filter(hasTargetText).length;
    summary.textContent = `${selectedCount}/${draft.segments.length}`;
    bulkSelection.checked =
      selectableCount > 0 && selectedCount === selectableCount;
    bulkSelection.indeterminate =
      selectedCount > 0 && selectedCount < selectableCount;
    bulkSelection.setAttribute(
      "aria-label",
      `Select all Segments, ${selectedCount} of ${draft.segments.length} selected`,
    );
  }

  function selectedSegments(): Segment[] {
    return draft.segments.filter((segment) => segment.selected);
  }

  function applyInteractionState(): void {
    const editingDisabled = disabled || merging;
    cardOrder.setDisabled(editingDisabled);
    list.inert = editingDisabled;
    generatePinyin.hidden = pinyinSource === null || pinyinVisible;
    generatePinyin.disabled = editingDisabled;
    pinyinStatus.hidden = pinyinSource === null;
    bulkSelection.disabled = editingDisabled;
    for (const button of list.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = editingDisabled;
    }
    for (const checkbox of list.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )) {
      checkbox.disabled = editingDisabled;
    }
    for (const textarea of [
      ...list.querySelectorAll<HTMLTextAreaElement>("textarea"),
      previewTarget,
      previewPinyin,
      previewTranslation,
    ]) {
      textarea.disabled = editingDisabled;
    }
  }

  function rowAt(index: number): HTMLTableRowElement | null {
    return list.querySelector(`[data-index="${index}"].segment-row`);
  }

  function previewInputFor(field: EditableField): HTMLTextAreaElement {
    if (field === "target") {
      return previewTarget;
    }
    return field === "pinyin" ? previewPinyin : previewTranslation;
  }

  function updatePreviewValidation(segment: Segment): void {
    const missingTarget = !hasTargetText(segment);
    previewTarget.setAttribute("aria-invalid", missingTarget.toString());
  }

  return {
    render,
    selectedSegments,
    setDisabled: (value) => {
      disabled = value;
      applyInteractionState();
    },
  };
}

type EditableField = "pinyin" | "target" | "translation";

function createRow(
  segment: Segment,
  index: number,
  pinyinVisible: boolean,
  draft: Draft,
): HTMLTableRowElement {
  const row = document.createElement("tr");
  row.className = "segment-row";
  row.dataset.index = index.toString();

  const selection = document.createElement("td");
  selection.className = "selection-column";
  const checkbox = document.createElement("input");
  checkbox.className = "segment-checkbox";
  checkbox.type = "checkbox";
  checkbox.checked = segment.selected;
  checkbox.dataset.index = index.toString();
  checkbox.setAttribute("aria-label", `Include Segment ${index + 1} in export`);
  selection.append(checkbox);

  const number = document.createElement("td");
  number.className = "number-column";
  const previewButton = document.createElement("button");
  previewButton.className = "row-preview-button";
  previewButton.type = "button";
  previewButton.textContent = String(index + 1).padStart(3, "0");
  previewButton.setAttribute(
    "aria-label",
    `Preview Segment ${index + 1}, ${formatRange(segment)}`,
  );
  number.append(previewButton);

  const time = document.createElement("td");
  time.className = "segment-time time-column";
  const range = document.createElement("span");
  range.textContent = formatRange(segment);
  time.append(range);

  row.append(
    selection,
    number,
    time,
    fieldCell("target", segment.target, index, draft),
  );
  if (pinyinVisible) {
    row.append(fieldCell("pinyin", segment.pinyin, index, draft));
  }
  if (draft.translationTrack) {
    row.append(fieldCell("translation", segment.translation, index, draft));
  }
  const lastCell = row.lastElementChild;
  if (segment.mergeSources) {
    lastCell?.append(
      mergeControl(
        "revert-merge",
        `Revert last merge for Segment ${index + 1}`,
        "M9 10H4V5m0 5 4-4a7 7 0 1 1 0 12",
      ),
    );
  }
  if (index < draft.segments.length - 1) {
    lastCell?.append(
      mergeControl(
        "merge-boundary",
        `Merge Segments ${index + 1} and ${index + 2}`,
        "M7 5l5 4 5-4M7 19l5-4 5 4",
      ),
    );
  }
  return row;
}

function mergeControl(
  className: string,
  label: string,
  icon: string,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.setAttribute("aria-label", label);
  button.title = label;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", icon);
  svg.append(path);
  button.append(svg);
  return button;
}

function fieldCell(
  field: EditableField,
  value: string,
  index: number,
  draft: Draft,
): HTMLTableCellElement {
  const cell = document.createElement("td");
  const input = document.createElement("textarea");
  input.className = "segment-textarea";
  input.dataset.field = field;
  input.dataset.index = index.toString();
  input.rows = 2;
  input.spellcheck = false;
  input.value = value;
  input.required = field === "target";
  input.setAttribute(
    "aria-label",
    `${fieldLabel(field, draft)} for Segment ${index + 1}`,
  );
  cell.append(input);
  return cell;
}

function fieldLabel(field: EditableField, draft: Draft): string {
  if (field === "pinyin") {
    return "Pinyin";
  }
  return (
    field === "target"
      ? draft.targetTrack.name
      : (draft.translationTrack?.name ?? "Track two")
  ).replace(/\s*\([^()]+\)\s*$/u, "");
}

export function hasTargetText(segment: Segment): boolean {
  return Boolean(segment.target.trim());
}

// The editor labels columns, preview fields and status text with the selected
// language name, so the trailing "(auto-generated)" style suffix is dropped.
export function shortTrackName(name: string): string {
  // Keep the original when the parenthetical is the whole name, so a label
  // never collapses to an empty string.
  return name.replace(/\s*\([^()]+\)\s*$/u, "").trim() || name;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

export function formatRange(segment: Segment): string {
  return `${formatTime(segment.startMs)}–${formatTime(segment.endMs)}`;
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}
