from voiced.visemes import Unit, build_track, en_shapes, ja_shapes, shapes_for, zh_shapes


def shapes(track):
    return [(v["t"], v["shape"]) for v in track]


def test_zh_finals_including_the_abbreviated_ones():
    assert zh_shapes("你好") == ["I", "A"]
    assert zh_shapes("对") == ["E"]
    assert zh_shapes("六") == ["O"]
    assert zh_shapes("绿") == ["U"]


def test_ja_morae_with_n():
    assert ja_shapes("こんにちは") == ["O", "N", "I", "I", "A"]


def test_en_cmudict_with_a_closed_onset_and_a_spelling_fallback():
    assert en_shapes("Hello") == ["A", "O"]
    assert en_shapes("maybe") == ["N", "E", "I"]
    assert en_shapes("Qwenzy") == ["E", "I"]


def test_each_unit_is_shaped_by_its_own_script():
    assert shapes_for("React", "zh") == ["I", "A"]
    assert shapes_for("東京", "ja") == ["O", "O", "O", "O"]
    assert shapes_for("東京", "zh") == ["O", "I"]
    assert shapes_for("2026", "en") == []


def test_zh_track():
    units = [Unit("你", 0.0, 0.16), Unit("好", 0.16, 0.40)]
    assert shapes(build_track(units, "zh")) == [(0, "I"), (160, "A"), (400, "rest")]


def test_en_track_rests_in_a_long_gap_only():
    units = [Unit("Hello", 0.0, 0.32), Unit("world", 0.40, 0.80), Unit("again", 1.10, 1.50)]
    assert shapes(build_track(units, "en")) == [
        (0, "A"), (160, "O"), (400, "E"), (800, "rest"), (1100, "A"), (1300, "E"), (1500, "rest"),
    ]


def test_ja_track():
    units = [Unit("こんにちは", 0.0, 0.60)]
    assert shapes(build_track(units, "ja")) == [(0, "O"), (120, "N"), (240, "I"), (480, "A"), (600, "rest")]


def test_mixed_language_sentence_reads_the_english_word_as_english():
    units = [Unit("我", 0.0, 0.2), Unit("用", 0.2, 0.4), Unit("React", 0.45, 0.9)]
    assert shapes(build_track(units, "zh")) == [(0, "O"), (450, "I"), (675, "A"), (900, "rest")]


def test_zero_length_unit_yields_to_a_shape_at_the_same_instant():
    units = [Unit("き", 0.8, 0.8), Unit("た", 0.8, 0.95)]
    assert shapes(build_track(units, "ja")) == [(800, "A"), (950, "rest")]


def test_digits_and_empty_input():
    assert shapes(build_track([Unit("2026", 0.0, 0.5)], "en")) == [(0, "A"), (500, "rest")]
    assert build_track([], "en") == []
