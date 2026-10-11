"""Impact Pack なしで維持する LoRA タグの契約。"""

import pytest

from nodes.lora_tags import split_lora_tags


@pytest.mark.parametrize("tag,expected", [
    ("<lora:style/name>", ("style/name", 1., 1., None, None, None, None)),
    ("<lora:name:.8>", ("name", .8, .8, None, None, None, None)),
    ("<lora:name:-.5:1.2>", ("name", -.5, 1.2, None, None, None, None)),
    ("<lora:name:1:0:LOADER=nunchaku>", ("name", 1., 0., None, None, None, "nunchaku")),
    ("<lora:name:.8:LBW=1,0,1;A=.2;B=.3>", ("name", .8, .8, "1,0,1", .2, .3, None)),
    ("<lora:name:LBW=preset:1,0,1;A=.2:LOADER=nunchaku>", ("name", 1., 1., "1,0,1", .2, None, "nunchaku")),
])
def test_lora_tag_weights_and_loader_options(tag, expected):
    clean, loras = split_lora_tags(f"before {tag} after")
    assert clean == "before  after"
    assert loras == [expected]


def test_only_lora_tags_are_removed_and_first_duplicate_wins():
    text = "{red|blue} __colors__ <image1> <lora:name:.2><lora:name:.9>"
    clean, loras = split_lora_tags(text)
    assert clean == "{red|blue} __colors__ <image1> "
    assert len(loras) == 1
    assert loras[0][1:3] == (.2, .2)


@pytest.mark.parametrize("tag", ["<lora::1>", "<lora:name:nan>", "<lora:name:inf>", "<lora:name:LBW=1;A=inf>"])
def test_invalid_names_and_nonfinite_weights_raise(tag):
    with pytest.raises(ValueError, match="LoRA"):
        split_lora_tags(tag)
