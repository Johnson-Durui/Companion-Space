import random

from app.teaching.lsp_parser import LspParser
from app.teaching.validators import answer_leaks, build_forbidden, clean_speech, validate_board


def parse(parts):
    parser = LspParser()
    events = [event for part in parts for event in parser.feed(part)]
    events.extend(parser.finish())
    return events, parser.stray_text, parser.stray_ask


def test_random_stream_boundaries_preserve_math_and_order():
    source = (
        '客套话\n```xml\n<board op=add id=work type=math title=“x > y”>'
        r'0<|x-a|<\delta' '\nf(x)<g(x) <br></board>'
        '<say>当 x<1 时，继续。现在试试！</say><mark target=work.2/>'
        '<board id=work type=text>new</board><point target=work/>'
        '<ask>private</ask><say>没有结束'
    )
    expected = parse([source])
    events, stray, stray_ask = expected
    assert events[0].data['content'] == r'0<|x-a|<\delta' + '\nf(x)<g(x) <br>'
    assert events[0].data['title'] == 'x > y'
    assert [event.type for event in events] == ['board', 'say', 'say', 'mark', 'board', 'point', 'say']
    assert events[3].data['target'] == 'work.2'
    assert events[4].data['id'] != 'work' and events[5].data['target'] == events[4].data['id']
    assert stray > 0 and stray_ask == 1
    assert parse(list(source)) == expected
    rng = random.Random(43)
    for _ in range(60):
        cuts = [0, *sorted(rng.sample(range(1, len(source)), 12)), len(source)]
        assert parse([source[a:b] for a, b in zip(cuts, cuts[1:])]) == expected


def test_unstructured_reply_falls_back_to_speech_but_ask_is_never_exposed():
    assert parse(['Check x<1.'])[0][0].data['text'] == 'Check x<1.'
    assert parse(['<ask>', 'answer', '</ask>'])[0] == []


def test_quoted_title_can_contain_a_complete_tag_at_a_chunk_boundary():
    beginning = '<board title="x <say>'
    end = ' y">content</board>'
    assert parse([beginning, end]) == parse([beginning + end])
    assert parse([beginning, end])[0][0].data["title"] == "x <say> y"


def test_answer_leakage_respects_question_and_visible_board():
    item = {'type': 'choice', 'stem': 'Pick one.', 'answer': 'B', 'options': [{'key': 'B', 'text': 'blue car'}]}
    assert answer_leaks('选 B', build_forbidden(item))
    assert answer_leaks('the BLUE CAR', build_forbidden(item))
    assert not answer_leaks('compare option B with the rest', build_forbidden(item))
    numeric = {'type': 'numeric', 'stem': 'Use 10.', 'answer': '3.0'}
    forbidden = build_forbidden(numeric)
    assert answer_leaks('等于 3', forbidden)
    assert answer_leaks('= 3.00', forbidden)
    assert not answer_leaks('See step 3.', forbidden)
    assert not answer_leaks('等于 3', forbidden, visible_text='The board already shows 3.')
    assert not answer_leaks('= 3', build_forbidden({**numeric, 'stem': 'Use 3.'}))


def test_speech_is_clean_and_board_only_addresses_existing_lines():
    assert clean_speech('**Think** $x+y$ # `inline code`') == 'Think x加y'
    events, _, _ = parse(['<board id=b type=steps>one\ntwo</board><mark target=b.2/><point target=b.3/>'])
    board = {}
    assert [validate_board(event, board) for event in events] == [True, True, False]
