"""実物の SAX_Bridge パッケージを import し、NODE_CLASS_MAPPINGS を JSON で出力する。

test_v3_schema.py からサブプロセスとして起動される。パッケージの ``__init__.py`` は
import 時に全ノードの ``execute`` をラップするため、pytest 本体のプロセスで import すると
他のテストへ副作用が及ぶ。独立プロセスで実行することでそれを避けつつ、実行時に構築される
``NODE_CLASS_MAPPINGS`` そのものを検証対象にできる。
"""

import importlib
import importlib.util
import json
import pkgutil
import sys
from pathlib import Path

_PKG_NAME = "sax_bridge_under_test"


def main() -> int:
    root = Path(sys.argv[1]).resolve()

    # conftest.py を import すると ComfyUI 依存のスタブが sys.modules に登録される
    sys.path.insert(0, str(root / "tests" / "python"))
    importlib.import_module("conftest")

    # ``from .nodes import ...`` が conftest 登録済みの ``nodes`` パッケージを指すようにする。
    # 各サブモジュールも別名登録しておき、モジュールの二重ロードを防ぐ。
    sys.modules[f"{_PKG_NAME}.nodes"] = sys.modules["nodes"]
    for info in pkgutil.iter_modules([str(root / "nodes")]):
        try:
            sys.modules[f"{_PKG_NAME}.nodes.{info.name}"] = importlib.import_module(
                f"nodes.{info.name}"
            )
        except Exception:  # 省略可能な依存を持つモジュールは別名登録をスキップする
            pass

    spec = importlib.util.spec_from_file_location(
        _PKG_NAME, root / "__init__.py", submodule_search_locations=[str(root)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[_PKG_NAME] = module
    spec.loader.exec_module(module)

    json.dump(
        {
            "class_mappings": {
                node_id: cls.__name__
                for node_id, cls in module.NODE_CLASS_MAPPINGS.items()
            },
            "display_name_mappings": dict(module.NODE_DISPLAY_NAME_MAPPINGS),
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
