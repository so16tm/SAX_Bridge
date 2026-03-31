"""
SAX_Bridge テスト用 conftest — ComfyUI 依存をモックで置換する。

使い方:
  cd projects/SAX_Bridge
  /path/to/comfyui/venv/Scripts/python -m pytest tests/ -v
"""

import sys
import types
from unittest.mock import MagicMock
from pathlib import Path

# ---------------------------------------------------------------------------
# 自動スタブ MetaPathFinder（comfy.* / comfy_extras.* を自動モック）
# ---------------------------------------------------------------------------

class _AutoStubFinder:
    """comfy / comfy_extras 配下の任意のサブモジュールを自動生成する。"""
    _ROOTS = ("comfy", "comfy_extras")

    def find_spec(self, fullname, path, target=None):
        if fullname not in sys.modules:
            parts = fullname.split(".")
            if parts[0] in self._ROOTS:
                from importlib.machinery import ModuleSpec
                return ModuleSpec(fullname, self)
        return None

    def create_module(self, spec):
        class _MockMod(types.ModuleType):
            def __getattr__(self, name):
                if name.startswith("_"):
                    raise AttributeError(name)
                val = MagicMock()
                setattr(self, name, val)
                return val

        mod = _MockMod(spec.name)
        mod.__path__ = []
        mod.__package__ = spec.name.rpartition(".")[0] or spec.name
        return mod

    def exec_module(self, module):
        pass

sys.meta_path.insert(0, _AutoStubFinder())

# ---------------------------------------------------------------------------
# ComfyUI モジュールのスタブ登録（import 前に必要）
# ---------------------------------------------------------------------------

# comfy_api.latest.io — V3 API の中核（未知の型も自動スタブ）
class _IoModule(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        val = _InputFactory(name)
        setattr(self, name, val)
        return val

io_mod = _IoModule("comfy_api.latest.io")

class _ComfyTypeIO:
    Type = object

class _ComfyNode:
    hidden = MagicMock()

    @classmethod
    def GET_SCHEMA(cls):
        return cls.define_schema()

class _NodeOutput:
    def __init__(self, *args, ui=None, expand=None, block_execution=None):
        self.args = args
        self.ui = ui
        self.expand = expand
        self.block_execution = block_execution

    @property
    def result(self):
        return self.args if self.args else None

    def __getitem__(self, index):
        return self.args[index]

class _Schema:
    def __init__(self, **kwargs):
        for k, v in kwargs.items():
            setattr(self, k, v)

class _InputFactory:
    def __init__(self, io_type="*"):
        self.io_type = io_type

    def Input(self, *args, **kwargs):
        return MagicMock(id=args[0] if args else None, io_type=self.io_type)

    def Output(self, *args, **kwargs):
        return MagicMock(io_type=self.io_type, display_name=kwargs.get("display_name"))

class _ComboFactory(_InputFactory):
    def Input(self, *args, **kwargs):
        m = MagicMock(id=args[0] if args else None, io_type="COMBO")
        m.options = kwargs.get("options", [])
        return m

class _AutogrowFactory:
    io_type = "AUTOGROW"
    Type = dict

    @staticmethod
    def Input(*args, **kwargs):
        return MagicMock(io_type="AUTOGROW")

    class TemplatePrefix:
        def __init__(self, *args, **kwargs):
            pass

class _HiddenEnum:
    unique_id = "UNIQUE_ID"
    prompt = "PROMPT"
    extra_pnginfo = "EXTRA_PNGINFO"

def _comfytype(**kwargs):
    def decorator(cls):
        cls.io_type = kwargs.get("io_type", "*")
        cls.Input = classmethod(lambda c, *a, **kw: MagicMock(io_type=cls.io_type))
        cls.Output = classmethod(lambda c, *a, **kw: MagicMock(io_type=cls.io_type))
        return cls
    return decorator

io_mod.ComfyNode = _ComfyNode
io_mod.ComfyTypeIO = _ComfyTypeIO
io_mod.NodeOutput = _NodeOutput
io_mod.Schema = _Schema
io_mod.Float = _InputFactory("FLOAT")
io_mod.Int = _InputFactory("INT")
io_mod.String = _InputFactory("STRING")
io_mod.Boolean = _InputFactory("BOOLEAN")
io_mod.Image = _InputFactory("IMAGE")
io_mod.Mask = _InputFactory("MASK")
io_mod.Conditioning = _InputFactory("CONDITIONING")
io_mod.Combo = _ComboFactory("COMBO")
io_mod.Autogrow = _AutogrowFactory()
io_mod.Hidden = _HiddenEnum
io_mod.comfytype = _comfytype

comfy_api = types.ModuleType("comfy_api")
comfy_api.__path__ = []
comfy_api_latest = types.ModuleType("comfy_api.latest")
comfy_api_latest.__path__ = []
comfy_api_latest.io = io_mod

sys.modules["comfy_api"] = comfy_api
sys.modules["comfy_api.latest"] = comfy_api_latest
sys.modules["comfy_api.latest.io"] = io_mod

# folder_paths（未知の属性も MagicMock を返す）
class _FolderPathsMod(types.ModuleType):
    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        val = MagicMock()
        setattr(self, name, val)
        return val

folder_paths = _FolderPathsMod("folder_paths")
folder_paths.get_filename_list = MagicMock(return_value=[])
folder_paths.get_output_directory = MagicMock(return_value="/tmp/comfyui_output")
folder_paths.get_temp_directory = MagicMock(return_value="/tmp/comfyui_temp")
folder_paths.get_folder_paths = MagicMock(return_value=[])
folder_paths.supported_pt_extensions = {".safetensors", ".ckpt", ".pt"}
folder_paths.get_full_path = MagicMock(return_value=None)
folder_paths.models_dir = "/tmp/comfyui_models"
sys.modules["folder_paths"] = folder_paths

# ---------------------------------------------------------------------------
# SAX_Bridge/nodes をパッケージとして登録
# ---------------------------------------------------------------------------

_bridge_root = Path(__file__).resolve().parent.parent.parent
if str(_bridge_root) not in sys.path:
    sys.path.insert(0, str(_bridge_root))

_nodes_pkg = _bridge_root / "nodes"
sax_nodes = types.ModuleType("nodes")
sax_nodes.__path__ = [str(_nodes_pkg)]
sax_nodes.__package__ = "nodes"
sax_nodes.CLIPTextEncode = MagicMock
sax_nodes.LoraLoader = MagicMock
sax_nodes.ConditioningConcat = MagicMock
sax_nodes.common_ksampler = MagicMock
sax_nodes.NODE_CLASS_MAPPINGS = {}
sys.modules["nodes"] = sax_nodes
