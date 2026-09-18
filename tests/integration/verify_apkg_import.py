"""Verify repeat package import against a disposable Anki collection."""

import json
import re
import sys
from pathlib import Path

from anki.collection import Collection, ImportAnkiPackageRequest


(
    collection_path,
    first_path,
    repeat_path,
    existing_identity,
    standard_path,
    expected_path,
) = map(
    Path, sys.argv[1:]
)
collection = Collection(str(collection_path))
expected_types = {
    item["name"]: item
    for item in json.loads(expected_path.read_text(encoding="utf-8"))
}

try:
    options = collection._backend.get_import_anki_package_presets()
    options.with_deck_configs = True
    first = collection.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=str(first_path),
            options=options,
        )
    )
    existing_ids = collection.find_notes(
        f'SegmentIdentity:"{existing_identity}"'
    )
    assert len(existing_ids) == 1
    existing = collection.get_note(existing_ids[0])
    old_model = collection.models.by_name("yt2anki-pinyin")
    assert old_model["css"] != expected_types["yt2anki-pinyin"]["css"]
    assert old_model["tmpls"][0]["afmt"] != expected_types["yt2anki-pinyin"]["back"]
    old_card_id = existing.card_ids()[0]
    existing["Target"] = "local edit"
    existing["Pinyin"] = "local pinyin edit"
    existing["PinyinUnderTranslation"] = "1"
    existing["TranslationFirst"] = ""
    collection.update_note(existing)

    card = collection.get_card(existing.card_ids()[0])
    card.due = 4242
    card.ivl = 17
    card.queue = 2
    card.type = 2
    collection.update_card(card)
    scheduling = (card.due, card.ivl, card.queue, card.type)

    repeat = collection.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=str(repeat_path),
            options=options,
        )
    )
    collection.models._clear_cache()
    existing = collection.get_note(existing_ids[0])
    assert existing["TranslationFirst"] == ""
    card = collection.get_card(existing.card_ids()[0])
    note_type_name = "yt2anki-pinyin"
    refreshed_model = collection.models.by_name(note_type_name)
    assert refreshed_model["id"] == old_model["id"]
    assert refreshed_model["css"] == expected_types[note_type_name]["css"]
    assert refreshed_model["tmpls"][0]["qfmt"] == expected_types[note_type_name]["front"]
    assert refreshed_model["tmpls"][0]["afmt"] == expected_types[note_type_name]["back"]
    assert card.id == old_card_id
    assert expected_types[note_type_name]["css"] in card.answer()
    deck_name = "Import fixture"
    deck_id = collection.decks.id(deck_name)
    deck_config = collection.decks.config_dict_for_deck_id(deck_id)
    new_cards = []
    for card_id in collection.find_cards(
        f'deck:"{deck_name}" note:"{note_type_name}" is:new'
    ):
        new_card = collection.get_card(card_id)
        new_note = new_card.note()
        new_cards.append((int(new_note["StartMs"]), new_card.due))
    new_cards.sort()
    answer_fields = []
    rendered_answers = {}
    for note_id in collection.find_notes(f'note:"{note_type_name}"'):
        note = collection.get_note(note_id)
        start_ms = int(note["StartMs"])
        answer_fields.append(
            (
                start_ms,
                note["Target"],
                note["Translation"],
                note["Pinyin"],
                note["PinyinUnderTranslation"],
            )
        )
        rendered_answers[start_ms] = collection.get_card(
            note.card_ids()[0]
        ).answer()
    answer_fields.sort()

    standard_first = collection.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=str(standard_path),
            options=options,
        )
    )
    standard_ids = collection.find_notes('note:"yt2anki"')
    assert len(standard_ids) == 1
    standard_note = collection.get_note(standard_ids[0])
    assert standard_note["TranslationFirst"] == "1"
    standard_note["TranslationFirst"] = ""
    collection.update_note(standard_note)
    standard_repeat = collection.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=str(standard_path),
            options=options,
        )
    )
    standard_ids = collection.find_notes('note:"yt2anki"')
    assert len(standard_ids) == 1
    standard_note = collection.get_note(standard_ids[0])
    assert standard_note["TranslationFirst"] == ""
    # Render the real imported Anki templates in both orders.
    for note_id in collection.find_notes('tag:yt2anki'):
        note = collection.get_note(note_id)
        saved_order = note["TranslationFirst"]
        for marker in ("", "1"):
            note["TranslationFirst"] = marker
            collection.update_note(note)
            answer = collection.get_card(note.card_ids()[0]).answer()
            classes = re.findall(r'<span class="yt2anki-(target|translation|pinyin)">', answer)
            first_group = ["target"]
            second_group = ["translation"] if note["Translation"] else []
            if "Pinyin" in note.keys() and note["Pinyin"]:
                (second_group if note["PinyinUnderTranslation"] else first_group).append("pinyin")
            assert classes == (second_group + first_group if marker else first_group + second_group)
        note["TranslationFirst"] = saved_order
        collection.update_note(note)

    note_type_names = sorted(
        item.name for item in collection.models.all_names_and_ids()
    )

    report = {
        "first": {
            "duplicate": len(first.log.duplicate),
            "new": len(first.log.new),
            "updated": len(first.log.updated),
        },
        "repeat": {
            "duplicate": len(repeat.log.duplicate),
            "new": len(repeat.log.new),
            "updated": len(repeat.log.updated),
        },
        "existingTarget": existing["Target"],
        "existingPinyin": existing["Pinyin"],
        "existingPinyinUnderTranslation": existing[
            "PinyinUnderTranslation"
        ],
        "answerFields": answer_fields,
        "targetOnlyOmitsTranslation": (
            'class="yt2anki-translation"' not in rendered_answers[1000]
            and 'class="yt2anki-target">local edit</span>'
            in rendered_answers[1000]
        ),
        "pinyinPreservedAndRendered": (
            'class="yt2anki-pinyin">local pinyin edit</span>'
            in rendered_answers[1000]
        ),
        "bilingualAnswerOrder": (
            0
            <= rendered_answers[4000].find('class="yt2anki-translation"')
            < rendered_answers[4000].find('class="yt2anki-target"')
        ),
        "schedulingPreserved": (
            card.due,
            card.ivl,
            card.queue,
            card.type,
        )
        == scheduling,
        "noteCount": len(
            note_ids := collection.find_notes(f'note:"{note_type_name}"')
        ),
        "cardCount": sum(
            len(collection.get_note(note_id).card_ids())
            for note_id in note_ids
        ),
        "noteTypeCount": sum(
            item.name == note_type_name
            for item in collection.models.all_names_and_ids()
        ),
        "standard": {
            "first": {
                "duplicate": len(standard_first.log.duplicate),
                "new": len(standard_first.log.new),
                "updated": len(standard_first.log.updated),
            },
            "repeat": {
                "duplicate": len(standard_repeat.log.duplicate),
                "new": len(standard_repeat.log.new),
                "updated": len(standard_repeat.log.updated),
            },
            "noteCount": len(standard_ids),
            "fieldCount": len(standard_note.keys()),
            "target": standard_note["Target"],
            "hasPinyinFields": (
                "Pinyin" in standard_note.keys()
                or "PinyinUnderTranslation" in standard_note.keys()
            ),
        },
        "ownedNoteTypeNames": [
            name
            for name in note_type_names
            if name in ("yt2anki", "yt2anki-pinyin")
        ],
        "suffixedNoteTypeCount": sum(
            name.startswith("yt2anki+")
            or name.startswith("yt2anki-pinyin+")
            for name in note_type_names
        ),
        "deckCount": sum(
            item.name == deck_name
            for item in collection.decks.all_names_and_ids()
        ),
        "rootDeckCount": sum(
            item.name == "yt2anki"
            for item in collection.decks.all_names_and_ids()
        ),
        "cardsInVideoDeck": all(
            collection.decks.name(collection.get_card(card_id).did)
            == deck_name
            for card_id in collection.find_cards(
                f'note:"{note_type_name}"'
            )
        ),
        "chronologicalNewCards": (
            [start for start, _due in new_cards] == [4000, 8000]
            and new_cards[0][1] < new_cards[1][1]
        ),
        "newCardPositions": new_cards,
        "deckConfigName": deck_config["name"],
        "deckConfigOrder": {
            "insert": deck_config["new"]["order"],
            "gather": deck_config["newGatherPriority"],
            "sort": deck_config["newSortOrder"],
        },
        "deckConfigNames": [
            config["name"] for config in collection.decks.all_config()
        ],
        "chronologicalPreset": (
            deck_config["name"] == "yt2anki"
            and deck_config["new"]["order"] == 1
            and deck_config["newGatherPriority"] == 1
            and deck_config["newSortOrder"] == 1
        ),
        "chronologicalPresetCount": sum(
            config["name"] == "yt2anki"
            for config in collection.decks.all_config()
        ),
    }
    default_collection_path = collection_path.with_name(
        f"default-{collection_path.name}"
    )
    default_collection = Collection(str(default_collection_path))
    try:
        default_options = (
            default_collection._backend.get_import_anki_package_presets()
        )
        default_collection.import_anki_package(
            ImportAnkiPackageRequest(
                package_path=str(first_path),
                options=default_options,
            )
        )
        default_model = default_collection.models.by_name(note_type_name)
        assert default_model["css"] != expected_types[note_type_name]["css"]
        default_collection.import_anki_package(
            ImportAnkiPackageRequest(
                package_path=str(repeat_path),
                options=default_options,
            )
        )
        default_collection.models._clear_cache()
        default_model = default_collection.models.by_name(note_type_name)
        assert default_model["css"] == expected_types[note_type_name]["css"]
        assert default_model["tmpls"][0]["afmt"] == expected_types[note_type_name]["back"]
        default_deck_id = default_collection.decks.id(deck_name)
        default_config = default_collection.decks.config_dict_for_deck_id(
            default_deck_id
        )
        default_positions = []
        for card_id in default_collection.find_cards(
            f'deck:"{deck_name}" note:"{note_type_name}" is:new'
        ):
            default_card = default_collection.get_card(card_id)
            default_note = default_card.note()
            default_positions.append(
                (int(default_note["StartMs"]), default_card.due)
            )
        default_positions.sort()
        report["defaultImport"] = {
            "deckConfigName": default_config["name"],
            "newCardPositions": default_positions,
            "chronologicalPresetCount": sum(
                config["name"] == "yt2anki"
                for config in default_collection.decks.all_config()
            ),
        }
    finally:
        default_collection.close()
    print(json.dumps(report))
finally:
    collection.close()
