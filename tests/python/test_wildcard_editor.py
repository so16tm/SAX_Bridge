"""独立ワイルドカードエディター: 書式非破壊と安全な保存。"""

import pytest

from nodes import wildcard_editor as wc


@pytest.fixture
def storage(tmp_path, monkeypatch):
    base = tmp_path / "ComfyUI"
    addon = base / "custom_nodes" / "ComfyUI-Autocomplete-Plus-Plus"
    (addon / "tags" / "wildcards").mkdir(parents=True)
    (base / "wildcards").mkdir()
    monkeypatch.setattr(wc.folder_paths, "base_path", str(base), raising=False)
    return base


def test_create_read_and_update_preserves_comment_empty_line_and_crlf(storage):
    original = "# comment\r\nred hair\r\n\r\n{3::blue | 1::green}\r\n"
    saved = wc.write_file("comfy", "clothing/hair.txt", original, None)
    assert saved["name"] == "clothing/hair"
    assert wc.read_file("comfy", "clothing/hair")["content"] == original
    altered = original + "__style/portrait__\r\n"
    wc.write_file("comfy", "clothing/hair", altered, saved["sha"])
    path = storage / "wildcards" / "clothing" / "hair.txt"
    assert path.read_bytes() == altered.encode("utf-8")
    assert wc.list_files()["files"][0]["name"] == "clothing/hair"


@pytest.mark.parametrize("filename", [
    "../danger", "folder/../danger", "/etc/shadow", "C:/Windows", "name.TXT",
    ".hidden/.", "folder//name", "CON", "trailing.", "bad:name",
])
def test_forbidden_paths(storage, filename):
    with pytest.raises(ValueError):
        wc.write_file("comfy", filename, "data", None)


def test_write_requires_latest_hash(storage):
    saved = wc.write_file("comfy", "animal", "cat\n", None)
    with pytest.raises(wc.WildcardConflict):
        wc.write_file("comfy", "animal", "dog\n", None)
    with pytest.raises(wc.WildcardConflict):
        wc.write_file("comfy", "animal", "dog\n", "0" * 64)
    assert wc.read_file("comfy", "animal")["sha"] == saved["sha"]


def test_other_root_same_name_is_reported_as_shadowed(storage):
    wc.write_file("comfy", "colors", "red\n", None)
    result = wc.write_file("tags:ComfyUI-Autocomplete-Plus-Plus", "colors", "blue\n", None)
    assert result["shadowed"]
    found = wc.list_files()["files"]
    assert [x["shadowed"] for x in found] == [False, True]


def test_symlink_cannot_escape_root(storage, tmp_path):
    target = tmp_path / "outside"
    target.mkdir()
    link = storage / "wildcards" / "out"
    try:
        link.symlink_to(target, target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlink not supported")
    with pytest.raises(ValueError):
        wc.write_file("comfy", "out/escape", "data", None)
    assert not (target / "escape.txt").exists()


def test_atomic_failure_preserves_original(storage, monkeypatch):
    original = wc.write_file("comfy", "colors", "red\n", None)
    def fail(*_args):
        raise OSError("disk full")
    monkeypatch.setattr(wc.os, "replace", fail)
    with pytest.raises(OSError):
        wc.write_file("comfy", "colors", "blue\n", original["sha"])
    path = storage / "wildcards" / "colors.txt"
    assert path.read_bytes() == b"red\n"
    assert not list(path.parent.glob("*.tmp"))


def test_delete_only_selected_file_and_promote_shadowed_copy(storage):
    saved = wc.write_file("comfy", "nested/colors", "red", None)
    wc.write_file("tags:ComfyUI-Autocomplete-Plus-Plus", "nested/colors", "blue", None)
    wc.write_file("comfy", "keep", "green", None)
    result = wc.delete_file("comfy", "nested/colors", saved["sha"])
    assert result == {"root_id": "comfy", "name": "nested/colors", "deleted": True}
    assert not (storage / "wildcards" / "nested" / "colors.txt").exists()
    assert wc.read_file("comfy", "keep")["content"] == "green"
    assert (storage / "wildcards" / "nested").is_dir()
    assert all(not file["shadowed"] for file in wc.list_files()["files"])


def test_delete_requires_latest_hash_and_existing_file(storage):
    saved = wc.write_file("comfy", "colors", "red", None)
    changed = wc.write_file("comfy", "colors", "blue", saved["sha"])
    with pytest.raises(wc.WildcardConflict):
        wc.delete_file("comfy", "colors", saved["sha"])
    assert wc.read_file("comfy", "colors")["content"] == "blue"
    wc.delete_file("comfy", "colors", changed["sha"])
    with pytest.raises(wc.WildcardConflict):
        wc.delete_file("comfy", "colors", changed["sha"])


@pytest.mark.parametrize("base_sha", [None, "", "wrong", 123])
def test_delete_rejects_invalid_hash(storage, base_sha):
    wc.write_file("comfy", "colors", "red", None)
    with pytest.raises(ValueError):
        wc.delete_file("comfy", "colors", base_sha)
    assert wc.read_file("comfy", "colors")["content"] == "red"


@pytest.mark.parametrize("name", ["../danger", "/absolute", "C:/Windows", "bad:name"])
def test_delete_rejects_paths_outside_roots(storage, name):
    with pytest.raises(ValueError):
        wc.delete_file("comfy", name, "0" * 64)


def test_delete_failure_preserves_file(storage, monkeypatch):
    saved = wc.write_file("comfy", "colors", "red", None)
    def fail(*_args, **_kwargs):
        raise OSError("permission denied")
    monkeypatch.setattr(wc.Path, "unlink", fail)
    with pytest.raises(OSError):
        wc.delete_file("comfy", "colors", saved["sha"])
    assert wc.read_file("comfy", "colors")["content"] == "red"
