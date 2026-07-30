import json
import pickle
import random
import shutil
import sqlite3
import sys
import time
from pathlib import Path

from anki.collection import Collection


base, addon_source = map(Path, sys.argv[1:])
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
collection.close()

addon_target = base / "addons21" / "2055492159"
addon_target.mkdir(parents=True)
for name in [
    "__init__.py",
    "config.md",
    "edit.py",
    "util.py",
    "web.py",
]:
    shutil.copy2(addon_source / name, addon_target / name)
config = {
    "apiKey": None,
    "apiLogPath": None,
    "webBindAddress": "127.0.0.1",
    "webBindPort": 8765,
    "webCorsOriginList": ["http://localhost"],
    "ignoreOriginList": [],
}
(addon_target / "config.json").write_text(
    json.dumps(config),
    encoding="utf8",
)
metadata = {
    "name": "AnkiConnect",
    "disabled": False,
    "mod": int((addon_source / "__init__.py").stat().st_mtime),
    "config": config,
}
(addon_target / "meta.json").write_text(
    json.dumps(metadata),
    encoding="utf8",
)
