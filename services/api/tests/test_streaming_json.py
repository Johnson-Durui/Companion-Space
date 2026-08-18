from app.services.streaming_json import JSONTextFieldStream


def test_json_text_field_stream_emits_only_decoded_display_text() -> None:
    decoder = JSONTextFieldStream("display_text")

    chunks = [
        '{"emotion":"warm","display',
        '_text":"先看定义，',
        r"再看一个\n例子：\u4f60",
        r'\u597d","spoken_text":"not streamed"}',
    ]
    emitted = [decoder.feed(chunk) for chunk in chunks]

    assert "".join(emitted) == "先看定义，再看一个\n例子：你好"
    assert "spoken_text" not in "".join(emitted)


def test_json_text_field_stream_handles_split_escape_and_surrogate_pair() -> None:
    decoder = JSONTextFieldStream("display_text")

    assert decoder.feed('{"display_text":"A\\') == "A"
    assert decoder.feed("uD83D") == ""
    assert decoder.feed("\\uDE80B\"}") == "🚀B"


def test_json_text_field_stream_ignores_plain_text_and_other_fields() -> None:
    decoder = JSONTextFieldStream("display_text")

    assert decoder.feed("This is not JSON") == ""
    assert decoder.feed(' and has \"spoken_text\":\"private\"') == ""
