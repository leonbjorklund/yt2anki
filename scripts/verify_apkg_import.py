import json
import sys
from pathlib import Path

from anki.collection import Collection, ImportAnkiPackageRequest


collection_path, first_path, repeat_path, existing_identity = map(
    Path, sys.argv[1:]
)
collection = Collection(str(collection_path))

try:
    options = collection._backend.get_import_anki_package_presets()
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
    existing["Target"] = "local edit"
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
    existing = collection.get_note(existing_ids[0])
    card = collection.get_card(existing.card_ids()[0])
    note_type_name = "yt2anki Listening v1"
    deck_name = "yt2anki::Import fixture"

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
    }
    print(json.dumps(report))
finally:
    collection.close()
