from comfy_api.latest import io

@io.comfytype(io_type="PIPE_LINE")
class PipeLine(io.ComfyTypeIO):
    Type = dict

