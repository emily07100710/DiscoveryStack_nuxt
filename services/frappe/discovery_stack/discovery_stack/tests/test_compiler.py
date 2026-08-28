from discovery_stack.compiler import canonical_json, compile_spec


def test_compiler_is_deterministic():
    spec = {"fingerprint": "a" * 64, "entities": [{"key": "lead", "fields": [{"key": "name", "type": "text"}]}], "roles": []}
    assert compile_spec(spec) == compile_spec(spec)
    assert canonical_json({"b": 1, "a": 2}) == '{"a":2,"b":1}'
