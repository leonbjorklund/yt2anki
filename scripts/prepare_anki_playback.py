import pickle
import random
import sqlite3
import sys
import time
from pathlib import Path

from anki.collection import Collection, ImportAnkiPackageRequest


base, package_path = map(Path, sys.argv[1:])
profile_name = "yt2anki"
profile_dir = base / profile_name
profile_dir.mkdir(parents=True)
(profile_dir / "collection.media").mkdir()

meta = {
    "ver": 0,
    "updates": False,
    "created": int(time.time()),
    "id": random.randrange(0, 2**63),
    "lastMsg": 0,
    "suppressUpdate": True,
    "firstRun": False,
    "defaultLang": "en_US",
    "last_run_version": 250905,
    "last_loaded_profile_name": profile_name,
}
profile = {
    "mainWindowGeom": None,
    "mainWindowState": None,
    "numBackups": 0,
    "lastOptimize": int(time.time()),
    "searchHistory": [],
    "syncKey": None,
    "syncMedia": False,
    "autoSync": False,
    "allowHTML": False,
    "importMode": 1,
    "lastColour": "#00f",
    "stripHTML": True,
    "deleteMedia": False,
}

preferences = sqlite3.connect(base / "prefs21.db")
try:
    preferences.execute(
        "create table profiles "
        "(name text primary key collate nocase, data blob not null)"
    )
    preferences.executemany(
        "insert into profiles values (?, ?)",
        [
            ("_global", pickle.dumps(meta)),
            (profile_name, pickle.dumps(profile)),
        ],
    )
    preferences.commit()
finally:
    preferences.close()

collection = Collection(str(profile_dir / "collection.anki2"))
try:
    result = collection.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=str(package_path),
            options=collection._backend.get_import_anki_package_presets(),
        )
    )
    deck_id = collection.decks.id_for_name(
        "yt2anki::Final playback fixture"
    )
    assert deck_id
    collection.decks.select(deck_id)
    assert len(result.log.new) == 1
    assert len(collection.find_cards("deck:yt2anki")) == 1
finally:
    collection.close()
