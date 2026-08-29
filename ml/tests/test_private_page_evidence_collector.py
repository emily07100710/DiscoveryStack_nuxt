from __future__ import annotations

import asyncio
import copy
import json
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))

import private_page_evidence_collector as collector  # noqa: E402
import validate_page_evidence_contract as validator  # noqa: E402
import cleanup_page_evidence_retention as cleanup  # noqa: E402


PUBLIC_V4 = "93.184.216.34"
PUBLIC_V6 = "2606:2800:220:1:248:1893:25c8:1946"
SCHEMA = (
    Path(__file__).resolve().parents[1] / "schemas" / "page-evidence-v1.schema.json"
)


def resolver_with(*answers: str):
    def resolve(_host: str, _port: int):
        return list(answers)

    return resolve


def failing_resolver(_host: str, _port: int):
    raise collector.PolicyError("dns_resolution_failed")


def make_bundle(**overrides):
    bundle = {
        "contractVersion": collector.TARGET_CONTRACT_VERSION,
        "parentLineage": {
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "parentRowCount": 1,
        },
        "authorization": {
            "scopeId": "scope-1",
            "ownerId": "owner-1",
            "approvedAt": "2026-08-28T00:00:00+00:00",
            "expiresAt": "2099-08-28T00:00:00+00:00",
            "allowedHosts": ["example.com"],
            "rightsBasis": "owner authorized public-page observation",
            "robotsPolicy": "respect",
            "retentionDays": 7,
            "allowAuthenticatedAccess": False,
        },
        "targets": [
            {
                "rowId": 1,
                "split": "train",
                "url": "https://example.com/page",
                "mappingProvenance": {
                    "method": collector.ALLOWED_MAPPING_METHOD,
                    "mappedBy": "owner-1",
                    "mappedAt": "2026-08-28T00:00:00+00:00",
                    "evidenceRef": "owner-mapping-sheet-row-1",
                    "robotsDecision": "allowed",
                },
                "queryContexts": [
                    {
                        "queryId": "q-1",
                        "queryText": "best example",
                        "intent": "informational",
                    }
                ],
            }
        ],
    }
    bundle.update(overrides)
    return bundle


def validate_bundle(bundle=None, parent_rows=None):
    return asyncio.run(
        collector.validate_target_bundle(
            bundle or make_bundle(),
            parent_rows=parent_rows or [{"rowId": 1, "split": "train"}],
            actual_parent_manifest_hash="a" * 64,
            actual_parent_dataset_digest="b" * 64,
            policy=collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
            now=datetime(2026, 8, 28, tzinfo=timezone.utc),
        )
    )


class FakeRoute:
    def __init__(self):
        self.continued = False
        self.aborted = False

    async def continue_(self):
        self.continued = True

    async def abort(self, _reason):
        self.aborted = True


class FakePage:
    def __init__(self, context, requests, *, websocket=False, final_url=None):
        self.context = context
        self.requests = requests
        self.emit_websocket = websocket
        self.url = final_url or "https://example.com/page"
        self.listeners = {}

    def on(self, event, callback):
        self.listeners[event] = callback

    async def goto(self, _url, **_kwargs):
        for method, url in self.requests:
            await self.context.route_handler(
                FakeRoute(), SimpleNamespace(method=method, url=url)
            )
        if self.emit_websocket:
            self.listeners["websocket"](object())
        response = SimpleNamespace(status=200, headers={})
        for callback in self.context.listeners.get("response", []):
            callback(response)
        return response

    async def wait_for_timeout(self, _milliseconds):
        return None

    async def evaluate(self, script):
        if script == collector.DOM_INSPECTION_SCRIPT:
            return {
                "title": "Public page",
                "metaDescription": "Safe",
                "headings": [],
                "bodyText": "public product documentation",
                "detailsText": [],
                "forms": [],
                "bodyScrollWidth": 1000,
                "visibleInteractiveCount": 0,
            }
        return None

    async def screenshot(self, **_kwargs):
        return b"fake-png"


class FakeContext:
    def __init__(self, requests, *, websocket=False, final_url=None):
        self.requests = requests
        self.websocket = websocket
        self.final_url = final_url
        self.listeners = {}
        self.route_handler = None
        self.page = None
        self.closed = False

    async def add_init_script(self, _script):
        return None

    async def route(self, _pattern, callback):
        self.route_handler = callback

    def on(self, event, callback):
        self.listeners.setdefault(event, []).append(callback)

    async def new_page(self):
        self.page = FakePage(
            self,
            self.requests,
            websocket=self.websocket,
            final_url=self.final_url,
        )
        return self.page

    async def close(self):
        self.closed = True


class FakeBrowser:
    def __init__(self, requests, *, websocket=False, final_url=None):
        self.requests = requests
        self.websocket = websocket
        self.final_url = final_url
        self.contexts = []
        self.context = None
        self.closed = False

    async def new_context(self, **_kwargs):
        self.context = FakeContext(
            self.requests,
            websocket=self.websocket,
            final_url=self.final_url,
        )
        self.contexts.append(self.context)
        return self.context

    async def close(self):
        self.closed = True


def assert_projection_unknown(test_case, status):
    projection = collector.unknown_projection(
        {
            "rowId": 1,
            "split": "train",
            "parentLineage": {
                "parentManifestHash": "a" * 64,
                "parentDatasetDigest": "b" * 64,
                "parentRowCount": 1,
            },
            "collectionStatus": status,
        },
        "c" * 64,
    )
    test_case.assertEqual(
        set(projection["frictionReasonSignals"].values()), {"unknown"}
    )


class URLPolicyTests(unittest.TestCase):
    def policy(self, *addresses, allow_http=False):
        return collector.PublicURLPolicy(
            resolver=resolver_with(*(addresses or (PUBLIC_V4,))), allow_http=allow_http
        )

    def test_01_defaults_missing_scheme_to_https(self):
        result = self.policy().validate("example.com/path")
        self.assertEqual(result.canonical_url, "https://example.com/path")

    def test_02_https_is_accepted(self):
        self.assertEqual(self.policy().validate("https://example.com").port, 443)

    def test_03_http_is_rejected_by_default(self):
        with self.assertRaisesRegex(collector.PolicyError, "https_required"):
            self.policy().validate("http://example.com")

    def test_04_http_requires_explicit_policy(self):
        result = self.policy(allow_http=True).validate("http://example.com")
        self.assertEqual(result.port, 80)

    def test_05_userinfo_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "userinfo_blocked"):
            self.policy().validate("https://user:pass@example.com")

    def test_06_nonnumeric_port_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "invalid_port"):
            self.policy().validate("https://example.com:nope")

    def test_07_nonstandard_port_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "port_blocked"):
            self.policy().validate("https://example.com:8443")

    def test_08_localhost_is_rejected(self):
        with self.assertRaises(collector.PolicyError):
            self.policy().validate("https://localhost")

    def test_09_special_use_suffix_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "special_use"):
            self.policy().validate("https://service.internal")

    def test_10_single_label_host_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "single_label"):
            self.policy().validate("https://intranet")

    def test_11_dns_failure_is_fail_closed(self):
        policy = collector.PublicURLPolicy(resolver=failing_resolver)
        with self.assertRaisesRegex(collector.PolicyError, "dns_resolution_failed"):
            policy.validate("https://example.com")

    def test_12_dns_empty_answer_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "dns_no_answers"):
            collector.PublicURLPolicy(resolver=resolver_with()).validate(
                "https://example.com"
            )

    def test_13_private_ipv4_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy("10.0.0.1").validate("https://example.com")

    def test_14_loopback_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy("127.0.0.1").validate("https://example.com")

    def test_15_link_local_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy("169.254.169.254").validate("https://example.com")

    def test_16_reserved_documentation_address_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy("192.0.2.1").validate("https://example.com")

    def test_17_multicast_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy("224.0.0.1").validate("https://example.com")

    def test_18_unspecified_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy("0.0.0.0").validate("https://example.com")

    def test_19_ipv4_mapped_ipv6_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "ipv4_mapped"):
            self.policy("::ffff:93.184.216.34").validate("https://example.com")

    def test_20_mixed_public_private_dns_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            self.policy(PUBLIC_V4, "10.0.0.1").validate("https://example.com")

    def test_21_public_ipv6_is_accepted(self):
        result = self.policy(PUBLIC_V6).validate("https://example.com")
        self.assertEqual(result.addresses, (PUBLIC_V6,))

    def test_22_idna_is_canonicalized_before_resolution(self):
        seen = []

        def resolver(host, _port):
            seen.append(host)
            return [PUBLIC_V4]

        result = collector.PublicURLPolicy(resolver=resolver).validate(
            "https://bücher.de/path"
        )
        self.assertEqual(result.hostname, "xn--bcher-kva.de")
        self.assertEqual(seen, ["xn--bcher-kva.de"])

    def test_23_fragment_is_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "fragment_blocked"):
            self.policy().validate("https://example.com/a?q=1#secret")

    def test_23b_invalid_hostname_characters_are_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "invalid_idna_host"):
            self.policy().validate("https://bad_name.example.org")

    def test_23c_async_dns_timeout_is_fail_closed(self):
        async def slow_resolver(_host, _port):
            await asyncio.sleep(0.05)
            return [PUBLIC_V4]

        policy = collector.PublicURLPolicy(
            async_resolver=slow_resolver,
            dns_timeout_seconds=0.001,
        )
        with self.assertRaisesRegex(collector.PolicyError, "dns_resolution_timeout"):
            asyncio.run(policy.validate_async("https://example.com"))

    def test_23d_async_dns_exception_is_redacted_and_fail_closed(self):
        secret = "Bearer " + ("a" * 26)

        async def broken_resolver(_host, _port):
            raise RuntimeError(secret)

        policy = collector.PublicURLPolicy(async_resolver=broken_resolver)
        with self.assertRaises(collector.PolicyError) as caught:
            asyncio.run(policy.validate_async("https://example.com"))
        self.assertEqual(str(caught.exception), "dns_resolution_failed")
        self.assertNotIn(secret, str(caught.exception))

    def test_23e_async_dns_empty_answer_is_fail_closed(self):
        async def empty_resolver(_host, _port):
            return []

        policy = collector.PublicURLPolicy(async_resolver=empty_resolver)
        with self.assertRaisesRegex(collector.PolicyError, "dns_no_answers"):
            asyncio.run(policy.validate_async("https://example.com"))

    def test_23f_async_dns_mixed_public_private_is_fail_closed(self):
        async def mixed_resolver(_host, _port):
            return [PUBLIC_V4, "10.0.0.1"]

        policy = collector.PublicURLPolicy(async_resolver=mixed_resolver)
        with self.assertRaisesRegex(collector.PolicyError, "non_public"):
            asyncio.run(policy.validate_async("https://example.com"))


class MappingTests(unittest.TestCase):
    def test_24_valid_exact_mapping_is_accepted(self):
        target = validate_bundle()[0]
        self.assertEqual((target["rowId"], target["split"]), (1, "train"))

    def test_25_parent_manifest_hash_must_match(self):
        bundle = make_bundle()
        bundle["parentLineage"]["parentManifestHash"] = "c" * 64
        with self.assertRaisesRegex(
            collector.MappingError, "parentManifestHash mismatch"
        ):
            validate_bundle(bundle)

    def test_26_parent_dataset_digest_must_match(self):
        bundle = make_bundle()
        bundle["parentLineage"]["parentDatasetDigest"] = "c" * 64
        with self.assertRaisesRegex(
            collector.MappingError, "parentDatasetDigest mismatch"
        ):
            validate_bundle(bundle)

    def test_27_parent_row_count_must_match(self):
        bundle = make_bundle()
        bundle["parentLineage"]["parentRowCount"] = 1087
        with self.assertRaisesRegex(collector.MappingError, "parentRowCount mismatch"):
            validate_bundle(bundle)

    def test_28_parent_rows_must_be_unique(self):
        bundle = make_bundle()
        bundle["parentLineage"]["parentRowCount"] = 2
        with self.assertRaisesRegex(
            collector.MappingError, "parent rowId values must be unique"
        ):
            validate_bundle(
                bundle,
                parent_rows=[
                    {"rowId": 1, "split": "train"},
                    {"rowId": 1, "split": "train"},
                ],
            )

    def test_29_target_rows_must_be_unique(self):
        bundle = make_bundle()
        bundle["targets"].append(copy.deepcopy(bundle["targets"][0]))
        with self.assertRaisesRegex(collector.MappingError, "exact unique"):
            validate_bundle(bundle)

    def test_30_split_must_exactly_match_parent(self):
        bundle = make_bundle()
        bundle["targets"][0]["split"] = "validation"
        with self.assertRaisesRegex(collector.MappingError, "exactly match parent"):
            validate_bundle(bundle)

    def test_31_semantic_mapping_method_is_rejected(self):
        bundle = make_bundle()
        bundle["targets"][0]["mappingProvenance"]["method"] = "semantic_search"
        with self.assertRaisesRegex(
            collector.MappingError, "only owner_supplied_exact_url"
        ):
            validate_bundle(bundle)

    def test_32_candidate_url_field_is_rejected(self):
        bundle = make_bundle()
        bundle["targets"][0]["candidateUrl"] = "https://example.com/guess"
        with self.assertRaisesRegex(collector.MappingError, "missing or unknown"):
            validate_bundle(bundle)

    def test_33_host_must_be_in_authorization_scope(self):
        bundle = make_bundle()
        bundle["authorization"]["allowedHosts"] = ["other.example"]
        with self.assertRaisesRegex(
            collector.MappingError, "outside owner authorization"
        ):
            validate_bundle(bundle)

    def test_34_expired_authorization_is_rejected(self):
        bundle = make_bundle()
        bundle["authorization"]["expiresAt"] = "2026-08-27T00:00:00+00:00"
        with self.assertRaisesRegex(collector.MappingError, "authorization expired"):
            validate_bundle(bundle)

    def test_35_authenticated_access_is_rejected(self):
        bundle = make_bundle()
        bundle["authorization"]["allowAuthenticatedAccess"] = True
        with self.assertRaisesRegex(collector.MappingError, "authenticated collection"):
            validate_bundle(bundle)

    def test_36_robots_must_be_owner_reviewed_allowed(self):
        bundle = make_bundle()
        bundle["targets"][0]["mappingProvenance"]["robotsDecision"] = "unknown"
        with self.assertRaisesRegex(collector.MappingError, "robots-disallowed"):
            validate_bundle(bundle)

    def test_37_retention_is_bounded(self):
        bundle = make_bundle()
        bundle["authorization"]["retentionDays"] = 365
        with self.assertRaisesRegex(collector.MappingError, "retentionDays"):
            validate_bundle(bundle)

    def test_38_query_ids_must_be_unique(self):
        bundle = make_bundle()
        bundle["targets"][0]["queryContexts"].append(
            copy.deepcopy(bundle["targets"][0]["queryContexts"][0])
        )
        with self.assertRaisesRegex(collector.MappingError, "queryId"):
            validate_bundle(bundle)

    def test_39_query_hash_binds_text_and_intent(self):
        queries = [{"queryId": "q-1", "queryText": "hello", "intent": "info"}]
        manifest, sidecar = collector.query_manifest_and_sidecar(queries)
        decoded = json.loads(sidecar)
        self.assertEqual(manifest[0]["queryHash"], decoded[0]["queryHash"])
        self.assertNotIn("queryText", manifest[0])

    def assert_sensitive_sidecar_rejected_without_leak(self, bundle, secret):
        with self.assertRaises(collector.MappingError) as caught:
            validate_bundle(bundle)
        self.assertEqual(str(caught.exception), "sensitive_sidecar_blocked")
        self.assertNotIn(secret, str(caught.exception))

    def test_39b_query_email_is_rejected_without_leak(self):
        bundle = make_bundle()
        secret = "person@example.com"
        bundle["targets"][0]["queryContexts"][0]["queryText"] = secret
        self.assert_sensitive_sidecar_rejected_without_leak(bundle, secret)

    def test_39c_intent_phone_is_rejected_without_leak(self):
        bundle = make_bundle()
        secret = "+1 (415) 555-1212"
        bundle["targets"][0]["queryContexts"][0]["intent"] = secret
        self.assert_sensitive_sidecar_rejected_without_leak(bundle, secret)

    def test_39d_query_bearer_token_is_rejected_without_leak(self):
        bundle = make_bundle()
        secret = "Bearer " + ("a" * 26)
        bundle["targets"][0]["queryContexts"][0]["queryText"] = secret
        self.assert_sensitive_sidecar_rejected_without_leak(bundle, secret)

    def test_39e_page_purpose_api_key_is_rejected_without_leak(self):
        bundle = make_bundle()
        secret = "api_key=" + ("a" * 26)
        bundle["targets"][0]["pagePurpose"] = secret
        self.assert_sensitive_sidecar_rejected_without_leak(bundle, secret)

    def test_39f_sidecar_malformed_type_is_rejected_without_value_leak(self):
        bundle = make_bundle()
        bundle["targets"][0]["queryContexts"][0]["intent"] = {"secret": "value"}
        with self.assertRaises(collector.MappingError) as caught:
            validate_bundle(bundle)
        self.assertEqual(str(caught.exception), "sidecar_invalid_type")
        self.assertNotIn("secret", str(caught.exception))

    def test_39g_sidecar_oversized_value_is_rejected_without_value_leak(self):
        bundle = make_bundle()
        oversized = "x" * (collector.MAX_PAGE_PURPOSE_BYTES + 1)
        bundle["targets"][0]["pagePurpose"] = oversized
        with self.assertRaises(collector.MappingError) as caught:
            validate_bundle(bundle)
        self.assertEqual(str(caught.exception), "sidecar_value_too_large")
        self.assertNotIn(oversized, str(caught.exception))


class FilesystemAndRuntimeTests(unittest.TestCase):
    def test_40_run_id_rejects_traversal(self):
        with self.assertRaises(collector.FilesystemPolicyError):
            collector.validate_run_id("../escape")

    def test_41_relative_path_rejects_absolute(self):
        with self.assertRaises(collector.FilesystemPolicyError):
            collector.validate_relative_path("/tmp/file")

    def test_42_relative_path_rejects_parent_segment(self):
        with self.assertRaises(collector.FilesystemPolicyError):
            collector.validate_relative_path("evidence/../secret")

    def test_43_store_refuses_existing_run_collision(self):
        with tempfile.TemporaryDirectory() as directory:
            collector.PrivateRunStore(Path(directory), "run-one")
            with self.assertRaisesRegex(collector.FilesystemPolicyError, "collision"):
                collector.PrivateRunStore(Path(directory), "run-one")

    def test_44_store_uses_private_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            store = collector.PrivateRunStore(Path(directory), "run-one")
            artifact = store.write_bytes(
                "evidence/row-1/value.bin", b"value", max_bytes=10
            )
            self.assertEqual(stat.S_IMODE(store.run_dir.stat().st_mode), 0o700)
            self.assertEqual(
                stat.S_IMODE(store.resolve(artifact["path"]).stat().st_mode), 0o600
            )

    def test_45_store_refuses_symlinked_output_root(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "real"
            target.mkdir()
            link = Path(directory) / "link"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(collector.FilesystemPolicyError, "symlink"):
                collector.PrivateRunStore(link, "run-one")

    def test_46_atomic_writer_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            store = collector.PrivateRunStore(Path(directory), "run-one")
            store.write_bytes("evidence/value.bin", b"one", max_bytes=10)
            with self.assertRaisesRegex(collector.FilesystemPolicyError, "overwrite"):
                store.write_bytes("evidence/value.bin", b"two", max_bytes=10)

    def test_47_artifact_size_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            store = collector.PrivateRunStore(Path(directory), "run-one")
            with self.assertRaisesRegex(collector.FilesystemPolicyError, "exceeds"):
                store.write_bytes("evidence/value.bin", b"1234", max_bytes=3)

    def test_48_output_inside_git_worktree_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".git").mkdir()
            with self.assertRaisesRegex(
                collector.FilesystemPolicyError, "outside every Git"
            ):
                collector.PrivateRunStore(root / "private", "run-one")

    def test_49_quarantine_move_updates_path_and_flag(self):
        with tempfile.TemporaryDirectory() as directory:
            store = collector.PrivateRunStore(Path(directory), "run-one")
            artifact = {
                "kind": "raw_text",
                **store.write_bytes("evidence/row-1/text.txt", b"x", max_bytes=10),
                "quarantined": False,
            }
            store.quarantine_artifact(artifact)
            self.assertTrue(artifact["quarantined"])
            self.assertTrue(store.resolve(artifact["path"]).is_file())

    def test_50_lighthouse_missing_binary_is_runtime_unavailable(self):
        with self.assertRaisesRegex(collector.RuntimeUnavailable, "missing"):
            collector.verify_lighthouse_binary(None)

    def test_51_lighthouse_relative_binary_is_rejected(self):
        with self.assertRaisesRegex(collector.RuntimeUnavailable, "absolute"):
            collector.verify_lighthouse_binary("node_modules/.bin/lighthouse")

    def test_52_lighthouse_version_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "lighthouse"
            binary.write_text("stub")
            binary.chmod(0o700)
            completed = SimpleNamespace(stdout="13.0.0\n", stderr="", returncode=0)
            with patch.object(collector.subprocess, "run", return_value=completed):
                with self.assertRaisesRegex(
                    collector.RuntimeUnavailable, "version_mismatch"
                ):
                    collector.verify_lighthouse_binary(str(binary))

    def test_53_lighthouse_exact_injected_version_is_accepted(self):
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "lighthouse"
            binary.write_text("stub")
            binary.chmod(0o700)
            completed = SimpleNamespace(
                stdout=f"{collector.LIGHTHOUSE_VERSION}\n", stderr="", returncode=0
            )
            with patch.object(collector.subprocess, "run", return_value=completed):
                runtime = collector.verify_lighthouse_binary(str(binary))
            self.assertEqual(runtime.version, collector.LIGHTHOUSE_VERSION)

    def test_54_source_has_no_dynamic_npx_or_click_dispatch(self):
        source = Path(collector.__file__).read_text(encoding="utf-8")
        self.assertNotIn("npx", source)
        self.assertNotIn(".click(", source)
        self.assertIn('service_workers="block"', source)
        self.assertIn('context.route("**/*", guard.route)', source)


class EgressAndSensitiveTests(unittest.TestCase):
    def collect_fake_viewport(
        self,
        requests,
        *,
        resolver=None,
        websocket=False,
        max_requests=10,
        final_url=None,
        allowed_hosts=frozenset({"example.com"}),
    ):
        policy = collector.PublicURLPolicy(
            resolver=resolver or resolver_with(PUBLIC_V4)
        )
        validated = asyncio.run(policy.validate_async("https://example.com/page"))
        browser = FakeBrowser(requests, websocket=websocket, final_url=final_url)
        with tempfile.TemporaryDirectory() as directory:
            store = collector.PrivateRunStore(Path(directory), "runtime-test")
            result, sensitive, guard = asyncio.run(
                collector.collect_viewport(
                    browser,
                    validated_url=validated,
                    viewport="desktop",
                    width=1440,
                    height=900,
                    store=store,
                    row_prefix="row-1",
                    max_requests=max_requests,
                    policy=policy,
                    allowed_hosts=allowed_hosts,
                )
            )
        return result, sensitive, guard, browser

    def assert_policy_blocked_and_unknown(self, result):
        self.assertEqual(result["status"], "blocked_policy")
        self.assertEqual(result["artifacts"], [])
        overall_status = collector.derive_collection_status(
            (result, {"status": "complete"}),
            sensitive_reasons=[],
            policy_reason_codes=[result["reason"]],
        )
        self.assertEqual(overall_status, "blocked_policy")
        assert_projection_unknown(self, overall_status)

    def test_55_sensitive_email_is_detected(self):
        self.assertEqual(
            collector.detect_sensitive_content("write me at user@example.com", []),
            ["email"],
        )

    def test_56_credential_form_is_detected(self):
        result = collector.detect_sensitive_content(
            "login", [{"inputTypes": ["password"], "autocomplete": []}]
        )
        self.assertIn("credential_form", result)

    def test_57_clear_text_is_not_marked_sensitive(self):
        self.assertEqual(
            collector.detect_sensitive_content("public product documentation", []), []
        )

    def test_57b_waf_challenge_text_is_recognized(self):
        self.assertIsNotNone(
            collector.WAF_CHALLENGE_RE.search("Checking your browser before continuing")
        )

    def test_58_retry_after_delta_seconds_is_bounded(self):
        self.assertEqual(collector.parse_retry_after("9999"), 300.0)

    def test_59_retry_after_date_is_parsed(self):
        now = datetime(2026, 8, 28, 0, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(
            collector.parse_retry_after("Fri, 28 Aug 2026 00:00:10 GMT", now=now), 10.0
        )

    def test_60_invalid_retry_after_is_zero(self):
        self.assertEqual(collector.parse_retry_after("later"), 0.0)

    def test_61_egress_guard_allows_guarded_get(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
            allowed_hosts=frozenset({"example.com"}),
        )
        route = FakeRoute()
        asyncio.run(
            guard.route(
                route, SimpleNamespace(method="GET", url="https://example.com/a")
            )
        )
        self.assertTrue(route.continued)
        self.assertEqual(guard.audit[0]["decision"], "allowed")

    def test_62_egress_guard_blocks_post(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
            allowed_hosts=frozenset({"example.com"}),
        )
        route = FakeRoute()
        asyncio.run(
            guard.route(
                route, SimpleNamespace(method="POST", url="https://example.com/a")
            )
        )
        self.assertTrue(route.aborted)
        self.assertEqual(guard.audit[0]["reason"], "method_blocked")

    def test_63_egress_guard_checks_subresource_url(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with("10.0.0.1")),
            allowed_hosts=frozenset({"example.com"}),
        )
        route = FakeRoute()
        asyncio.run(
            guard.route(
                route,
                SimpleNamespace(method="GET", url="https://assets.example.com/app.js"),
            )
        )
        self.assertTrue(route.aborted)
        self.assertEqual(guard.blocked_count, 1)

    def test_64_egress_guard_enforces_request_budget(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
            allowed_hosts=frozenset({"example.com"}),
            max_requests=1,
        )
        first, second = FakeRoute(), FakeRoute()
        asyncio.run(
            guard.route(
                first, SimpleNamespace(method="GET", url="https://example.com/1")
            )
        )
        asyncio.run(
            guard.route(
                second, SimpleNamespace(method="GET", url="https://example.com/2")
            )
        )
        self.assertTrue(first.continued)
        self.assertTrue(second.aborted)

    def test_64b_redirect_request_is_revalidated(self):
        answers = iter([[PUBLIC_V4], ["127.0.0.1"]])

        def changing_resolver(_host, _port):
            return next(answers)

        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=changing_resolver),
            allowed_hosts=frozenset({"example.com"}),
        )
        initial, redirect = FakeRoute(), FakeRoute()
        asyncio.run(
            guard.route(
                initial,
                SimpleNamespace(method="GET", url="https://example.com/start"),
            )
        )
        asyncio.run(
            guard.route(
                redirect,
                SimpleNamespace(method="GET", url="https://example.com/redirect"),
            )
        )
        self.assertTrue(initial.continued)
        self.assertTrue(redirect.aborted)

    def test_65_websocket_event_sets_hard_blocker(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
            allowed_hosts=frozenset({"example.com"}),
        )
        guard.on_websocket(object())
        self.assertTrue(guard.websocket_seen)

    def test_66_response_retry_after_is_recorded(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
            allowed_hosts=frozenset({"example.com"}),
        )
        guard.on_response(SimpleNamespace(status=429, headers={"retry-after": "12"}))
        self.assertEqual(guard.retry_after_seconds, 12.0)

    def test_67_exact_replay_accepts_identical_metadata(self):
        metadata = {
            "runId": "source-run",
            "targetBundleDigest": "a" * 64,
            "parentManifestHash": "b" * 64,
            "parentDatasetDigest": "c" * 64,
            "configDigest": "d" * 64,
            "selectionFingerprint": "e" * 64,
            "ownerAuthorityFingerprint": "f" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
        }
        replay = collector.validate_replay(
            metadata,
            replay_of="source-run",
            target_bundle_digest="a" * 64,
            parent_manifest_hash="b" * 64,
            parent_dataset_digest="c" * 64,
            config_digest="d" * 64,
            selection_fingerprint="e" * 64,
            owner_authority_fingerprint="f" * 64,
        )
        self.assertTrue(replay["exactReplay"])

    def test_68_exact_replay_rejects_config_drift(self):
        metadata = {
            "runId": "source-run",
            "targetBundleDigest": "a" * 64,
            "parentManifestHash": "b" * 64,
            "parentDatasetDigest": "c" * 64,
            "configDigest": "x" * 64,
            "selectionFingerprint": "e" * 64,
            "ownerAuthorityFingerprint": "f" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
        }
        with self.assertRaisesRegex(collector.MappingError, "configDigest"):
            collector.validate_replay(
                metadata,
                replay_of="source-run",
                target_bundle_digest="a" * 64,
                parent_manifest_hash="b" * 64,
                parent_dataset_digest="c" * 64,
                config_digest="d" * 64,
                selection_fingerprint="e" * 64,
                owner_authority_fingerprint="f" * 64,
            )

    def test_68b_runtime_post_violation_cannot_complete_or_project(self):
        result, _sensitive, guard, _browser = self.collect_fake_viewport(
            [
                ("GET", "https://example.com/page"),
                ("POST", "https://example.com/api"),
            ]
        )
        self.assert_policy_blocked_and_unknown(result)
        self.assertIn("method_blocked", guard.policy_reason_codes)
        self.assertEqual(guard.blocked_count, 1)

    def test_68c_runtime_private_subrequest_cannot_complete_or_project(self):
        def host_resolver(host, _port):
            return ["10.0.0.1"] if host == "assets.example.com" else [PUBLIC_V4]

        result, _sensitive, guard, _browser = self.collect_fake_viewport(
            [
                ("GET", "https://example.com/page"),
                ("GET", "https://assets.example.com/app.js"),
            ],
            resolver=host_resolver,
        )
        self.assert_policy_blocked_and_unknown(result)
        self.assertIn("non_public_address_blocked", guard.policy_reason_codes)

    def test_68d_runtime_special_use_cross_origin_cannot_complete_or_project(self):
        result, _sensitive, guard, _browser = self.collect_fake_viewport(
            [
                ("GET", "https://example.com/page"),
                ("GET", "https://metadata.local/latest"),
            ]
        )
        self.assert_policy_blocked_and_unknown(result)
        self.assertIn("special_use_host_blocked", guard.policy_reason_codes)

    def test_68e_runtime_budget_violation_cannot_complete_or_project(self):
        result, _sensitive, guard, _browser = self.collect_fake_viewport(
            [
                ("GET", "https://example.com/page"),
                ("GET", "https://example.com/app.js"),
            ],
            max_requests=1,
        )
        self.assert_policy_blocked_and_unknown(result)
        self.assertIn("request_budget_exceeded", guard.policy_reason_codes)

    def test_68f_websocket_listener_is_on_page_and_fails_closed(self):
        result, _sensitive, guard, browser = self.collect_fake_viewport(
            [("GET", "https://example.com/page")],
            websocket=True,
        )
        self.assertIn("websocket", browser.context.page.listeners)
        self.assertNotIn("websocket", browser.context.listeners)
        self.assertTrue(guard.websocket_seen)
        self.assertIn(
            "websocket_observed_sandbox_hard_blocker",
            guard.policy_reason_codes,
        )
        self.assert_policy_blocked_and_unknown(result)

    def test_68g_runtime_redirect_dns_rebinding_is_revalidated_and_blocked(self):
        answers = iter([[PUBLIC_V4], [PUBLIC_V4], ["127.0.0.1"]])

        def rebinding_resolver(_host, _port):
            return next(answers)

        result, _sensitive, guard, _browser = self.collect_fake_viewport(
            [
                ("GET", "https://example.com/start"),
                ("GET", "https://example.com/redirect"),
            ],
            resolver=rebinding_resolver,
        )
        self.assert_policy_blocked_and_unknown(result)
        self.assertEqual(guard.blocked_count, 1)

    def test_68h_clear_page_screenshot_is_still_private_quarantine(self):
        result, _sensitive, guard, _browser = self.collect_fake_viewport(
            [("GET", "https://example.com/page")]
        )
        self.assertEqual(result["status"], "complete")
        self.assertEqual(guard.policy_reason_codes, [])
        screenshot = next(
            artifact
            for artifact in result["artifacts"]
            if artifact["kind"] == "screenshot"
        )
        self.assertTrue(screenshot["quarantined"])
        self.assertTrue(screenshot["path"].startswith("quarantined_visual_evidence/"))


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_record(self, status="sandbox_required"):
        mapping = {
            "urlHash": "c" * 64,
            "method": collector.ALLOWED_MAPPING_METHOD,
            "evidenceRefHash": "d" * 64,
            "mappedByHash": "e" * 64,
            "mappedAt": "2026-08-28T00:00:00+00:00",
            "robotsDecision": "allowed",
            "authorizationScopeId": "scope-1",
            "ownerAuthorityFingerprint": "2" * 64,
            "pagePurposeHash": None,
        }
        mapping["mappingFingerprint"] = collector.sha256_bytes(
            collector.canonical_json_bytes(
                {
                    "rowId": 1,
                    "split": "train",
                    "urlHash": mapping["urlHash"],
                    "method": mapping["method"],
                    "mappedByHash": mapping["mappedByHash"],
                    "mappedAt": mapping["mappedAt"],
                    "evidenceRefHash": mapping["evidenceRefHash"],
                    "robotsDecision": mapping["robotsDecision"],
                    "ownerAuthorityFingerprint": mapping[
                        "ownerAuthorityFingerprint"
                    ],
                }
            )
        )
        return collector.make_blocked_record(
            run_id="test-run",
            row_id=1,
            split="train",
            lineage={
                "parentManifestHash": "a" * 64,
                "parentDatasetDigest": "b" * 64,
                "parentRowCount": 1,
            },
            mapping=mapping,
            queries=[],
            status=status,
            reason="sandbox not attested",
            replay={
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
            max_requests=180,
        )

    def write_run(self, record, projection=None, store=None):
        store = store or collector.PrivateRunStore(self.root, "test-run")
        metadata = {
            "runId": "test-run",
            "targetBundleDigest": "f" * 64,
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "configDigest": "1" * 64,
            "selectionFingerprint": "2" * 64,
            "ownerAuthorityFingerprint": "2" * 64,
            "collectorSourceHash": "4" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
            "state": "complete",
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
            "retentionUntil": "2026-09-04T00:00:00+00:00",
            "replay": {
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
        }
        store.write_json("run_metadata.json", metadata, max_bytes=1024 * 1024)
        store.append_jsonl("evidence_manifest.jsonl", record)
        projection = projection or collector.unknown_projection(
            record, collector.sha256_bytes(collector.canonical_json_bytes(record))
        )
        store.append_jsonl("model_projection.jsonl", projection)
        completion = {
            "contractVersion": "page-evidence-completion-v1",
            "runId": "test-run",
            "completedAt": "2026-08-28T00:01:00+00:00",
            "metadataHash": collector.sha256_file(store.run_dir / "run_metadata.json"),
            "evidenceManifestHash": collector.sha256_file(
                store.run_dir / "evidence_manifest.jsonl"
            ),
            "modelProjectionHash": collector.sha256_file(
                store.run_dir / "model_projection.jsonl"
            ),
            "selectionFingerprint": "2" * 64,
            "ownerAuthorityFingerprint": "2" * 64,
        }
        store.write_json("run_complete.json", completion, max_bytes=1024 * 1024)
        return store

    def collect_complete_record(self):
        store = collector.PrivateRunStore(self.root, "test-run")
        policy = collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
        validated_url = asyncio.run(policy.validate_async("https://example.com/page"))
        browser = FakeBrowser([("GET", "https://example.com/page")])
        desktop, desktop_sensitive, desktop_guard = asyncio.run(
            collector.collect_viewport(
                browser,
                validated_url=validated_url,
                viewport="desktop",
                width=1440,
                height=900,
                store=store,
                row_prefix="row-1",
                max_requests=10,
                policy=policy,
                allowed_hosts=frozenset({"example.com"}),
            )
        )
        mobile, mobile_sensitive, mobile_guard = asyncio.run(
            collector.collect_viewport(
                browser,
                validated_url=validated_url,
                viewport="mobile",
                width=390,
                height=844,
                store=store,
                row_prefix="row-1",
                max_requests=10,
                policy=policy,
                allowed_hosts=frozenset({"example.com"}),
            )
        )
        self.assertEqual(desktop_sensitive + mobile_sensitive, [])
        request_entries = desktop_guard.audit + mobile_guard.audit
        for sequence, entry in enumerate(request_entries, start=1):
            entry["sequence"] = sequence
        lineage = {
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "parentRowCount": 1,
        }
        artifacts = desktop["artifacts"] + mobile["artifacts"]
        record = {
            "contractVersion": collector.CONTRACT_VERSION,
            "collectionRunId": "test-run",
            "collectedAt": "2026-08-28T00:00:00+00:00",
            "rowId": 1,
            "split": "train",
            "parentLineage": lineage,
            "mapping": {
                "urlHash": validated_url.url_hash,
                "method": collector.ALLOWED_MAPPING_METHOD,
                "evidenceRefHash": "d" * 64,
                "mappedByHash": "e" * 64,
                "mappedAt": "2026-08-28T00:00:00+00:00",
                "robotsDecision": "allowed",
                "authorizationScopeId": "scope-1",
                "ownerAuthorityFingerprint": "2" * 64,
                "mappingFingerprint": "3" * 64,
                "pagePurposeHash": None,
            },
            "collectionStatus": "complete",
            "page": {
                "status": "complete",
                "sensitiveReasons": [],
                "observationsIncluded": True,
            },
            "responsive": {"desktop": desktop, "mobile": mobile},
            "lighthouse": {
                preset: {
                    "status": "not_run",
                    "reason": "not_requested",
                    "version": collector.LIGHTHOUSE_VERSION,
                    "artifact": None,
                }
                for preset in ("desktop", "mobile")
            },
            "interactionTrace": {
                "allowedActions": [
                    "dom_inspect",
                    "scroll",
                    "screenshot",
                    "native_details_text_read",
                ],
                "dispatchedClicks": 0,
                "formsSubmitted": 0,
                "bookingStatus": "unknown",
                "checkoutStatus": "unknown",
            },
            "queryContexts": [],
            "governance": {
                "privateOnly": True,
                "developmentOnly": True,
                "containsPii": False,
                "containsCredentials": False,
                "quarantineStatus": "clear",
                "modelArtifactRawEvidenceExcluded": True,
            },
            "requestAudit": {
                "count": desktop_guard.request_count + mobile_guard.request_count,
                "maxCount": 22,
                "blockedCount": 0,
                "policyReasonCodes": [],
                "allRequestsGuarded": True,
                "serviceWorkersBlocked": True,
                "websocketPolicy": "sandbox_hard_blocker",
                "entries": request_entries,
            },
            "artifacts": artifacts,
            "replay": {
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
        }
        mapping = record["mapping"]
        mapping["mappingFingerprint"] = collector.sha256_bytes(
            collector.canonical_json_bytes(
                {
                    "rowId": record["rowId"],
                    "split": record["split"],
                    "urlHash": mapping["urlHash"],
                    "method": mapping["method"],
                    "mappedByHash": mapping["mappedByHash"],
                    "mappedAt": mapping["mappedAt"],
                    "evidenceRefHash": mapping["evidenceRefHash"],
                    "robotsDecision": mapping["robotsDecision"],
                    "ownerAuthorityFingerprint": mapping[
                        "ownerAuthorityFingerprint"
                    ],
                }
            )
        )
        return store, record

    def test_69_valid_blocked_run_passes(self):
        store = self.write_run(self.make_record())
        result = validator.validate_run(store.run_dir, SCHEMA)
        self.assertTrue(result["valid"])

    def test_70_schema_rejects_unknown_field(self):
        record = self.make_record()
        record["unexpected"] = True
        store = self.write_run(record)
        with self.assertRaisesRegex(validator.ValidationError, "unknown keys"):
            validator.validate_run(store.run_dir, SCHEMA)

    def test_71_projection_rejects_raw_url_value(self):
        record = self.make_record()
        projection = collector.unknown_projection(
            record, collector.sha256_bytes(collector.canonical_json_bytes(record))
        )
        projection["frictionReasonSignals"]["booking_friction"] = "https://example.com"
        store = self.write_run(record, projection)
        with self.assertRaises(validator.ValidationError):
            validator.validate_run(store.run_dir, SCHEMA)

    def test_72_projection_rejects_negative_instead_of_unknown(self):
        record = self.make_record()
        projection = collector.unknown_projection(
            record, collector.sha256_bytes(collector.canonical_json_bytes(record))
        )
        projection["frictionReasonSignals"]["booking_friction"] = "negative"
        store = self.write_run(record, projection)
        with self.assertRaisesRegex(validator.ValidationError, "must equal 'unknown'"):
            validator.validate_run(store.run_dir, SCHEMA)

    def test_73_status_semantics_are_enforced(self):
        record = self.make_record()
        record["collectionStatus"] = "complete"
        record["page"]["status"] = "complete"
        store = self.write_run(record)
        with self.assertRaisesRegex(validator.ValidationError, "complete requires"):
            validator.validate_run(store.run_dir, SCHEMA)

    def test_74_artifact_hash_is_verified(self):
        record = self.make_record(status="failed")
        store = collector.PrivateRunStore(self.root, "test-run")
        artifact = {
            "kind": "raw_text",
            **store.write_bytes("evidence/row-1/text.txt", b"safe", max_bytes=10),
            "quarantined": False,
        }
        artifact["sha256"] = "0" * 64
        record["artifacts"] = [artifact]
        record["responsive"]["desktop"]["artifacts"] = [artifact]
        metadata = {
            "runId": "test-run",
            "targetBundleDigest": "f" * 64,
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "configDigest": "1" * 64,
            "selectionFingerprint": "2" * 64,
            "ownerAuthorityFingerprint": "2" * 64,
            "collectorSourceHash": "4" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
            "state": "in_progress",
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
            "retentionUntil": "2026-09-04T00:00:00+00:00",
            "replay": {
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
        }
        store.write_json("run_metadata.json", metadata, max_bytes=1024 * 1024)
        store.append_jsonl("evidence_manifest.jsonl", record)
        store.append_jsonl(
            "model_projection.jsonl",
            collector.unknown_projection(
                record, collector.sha256_bytes(collector.canonical_json_bytes(record))
            ),
        )
        with self.assertRaisesRegex(validator.ValidationError, "sha256 mismatch"):
            validator.validate_run(store.run_dir, SCHEMA, require_complete=False)

    def test_75_artifact_symlink_is_rejected(self):
        record = self.make_record(status="failed")
        store = collector.PrivateRunStore(self.root, "test-run")
        outside = self.root / "outside"
        outside.write_bytes(b"x")
        outside.chmod(0o600)
        link = store.resolve("evidence/row-1-link")
        link.symlink_to(outside)
        record["artifacts"] = [
            {
                "kind": "raw_text",
                "path": "evidence/row-1-link",
                "sha256": collector.sha256_bytes(b"x"),
                "bytes": 1,
                "quarantined": False,
            }
        ]
        record["responsive"]["desktop"]["artifacts"] = record["artifacts"]
        metadata = {
            "runId": "test-run",
            "targetBundleDigest": "f" * 64,
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "configDigest": "1" * 64,
            "selectionFingerprint": "2" * 64,
            "ownerAuthorityFingerprint": "2" * 64,
            "collectorSourceHash": "4" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
            "state": "in_progress",
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
            "retentionUntil": "2026-09-04T00:00:00+00:00",
            "replay": {
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
        }
        store.write_json("run_metadata.json", metadata, max_bytes=1024 * 1024)
        store.append_jsonl("evidence_manifest.jsonl", record)
        store.append_jsonl(
            "model_projection.jsonl",
            collector.unknown_projection(
                record, collector.sha256_bytes(collector.canonical_json_bytes(record))
            ),
        )
        with self.assertRaisesRegex(validator.ValidationError, "symlink"):
            validator.validate_run(store.run_dir, SCHEMA, require_complete=False)

    def test_76_sensitive_evidence_cannot_stay_in_general_directory(self):
        record = self.make_record(status="quarantined_sensitive")
        record["page"].update(
            {"sensitiveReasons": ["email"], "observationsIncluded": False}
        )
        record["governance"].update(
            {"containsPii": True, "quarantineStatus": "quarantined_sensitive_evidence"}
        )
        record["responsive"]["desktop"]["status"] = "quarantined_sensitive"
        record["responsive"]["mobile"]["status"] = "quarantined_sensitive"
        for viewport in record["responsive"].values():
            viewport["httpStatus"] = 200
            viewport["finalUrlHash"] = "9" * 64
            viewport["observations"] = {
                "title": None,
                "metaDescription": None,
                "headings": [],
                "detailsText": [],
                "formsObservedWithoutInput": 0,
            }
        store = collector.PrivateRunStore(self.root, "test-run")
        artifact = {
            "kind": "raw_text",
            **store.write_bytes(
                "evidence/row-1/text.txt", b"user@example.com", max_bytes=100
            ),
            "quarantined": False,
        }
        record["artifacts"] = [artifact]
        record["responsive"]["desktop"]["artifacts"] = [artifact]
        metadata = {
            "runId": "test-run",
            "targetBundleDigest": "f" * 64,
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "configDigest": "1" * 64,
            "selectionFingerprint": "2" * 64,
            "ownerAuthorityFingerprint": "2" * 64,
            "collectorSourceHash": "4" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
            "state": "in_progress",
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
            "retentionUntil": "2026-09-04T00:00:00+00:00",
            "replay": {
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
        }
        store.write_json("run_metadata.json", metadata, max_bytes=1024 * 1024)
        store.append_jsonl("evidence_manifest.jsonl", record)
        store.append_jsonl(
            "model_projection.jsonl",
            collector.unknown_projection(
                record, collector.sha256_bytes(collector.canonical_json_bytes(record))
            ),
        )
        with self.assertRaisesRegex(
            validator.ValidationError, "all sensitive-page artifacts"
        ):
            validator.validate_run(store.run_dir, SCHEMA, require_complete=False)

    def test_77_query_sidecar_hash_is_recomputed(self):
        record = self.make_record(status="failed")
        record["queryContexts"] = [
            {"queryId": "q-1", "queryHash": "0" * 64, "status": "provided"}
        ]
        store = collector.PrivateRunStore(self.root, "test-run")
        payload = [
            {
                "queryId": "q-1",
                "queryText": "hello",
                "intent": None,
                "queryHash": "0" * 64,
            }
        ]
        artifact = {
            "kind": "private_query_sidecar",
            **store.write_json(
                "evidence/row-1/private-query-contexts.json", payload, max_bytes=10000
            ),
            "quarantined": False,
        }
        record["artifacts"] = [artifact]
        metadata = {
            "runId": "test-run",
            "targetBundleDigest": "f" * 64,
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "configDigest": "1" * 64,
            "selectionFingerprint": "2" * 64,
            "ownerAuthorityFingerprint": "2" * 64,
            "collectorSourceHash": "4" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
            "state": "in_progress",
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
            "retentionUntil": "2026-09-04T00:00:00+00:00",
            "replay": {
                "replayOf": None,
                "exactReplay": False,
                "sourceRunMetadataHash": None,
            },
        }
        store.write_json("run_metadata.json", metadata, max_bytes=1024 * 1024)
        store.append_jsonl("evidence_manifest.jsonl", record)
        store.append_jsonl(
            "model_projection.jsonl",
            collector.unknown_projection(
                record, collector.sha256_bytes(collector.canonical_json_bytes(record))
            ),
        )
        with self.assertRaisesRegex(validator.ValidationError, "query hash mismatch"):
            validator.validate_run(store.run_dir, SCHEMA, require_complete=False)

    def test_78_schema_requires_complete_mapping_provenance(self):
        record = self.make_record()
        del record["mapping"]["authorizationScopeId"]
        store = self.write_run(record)
        with self.assertRaisesRegex(validator.ValidationError, "missing required"):
            validator.validate_run(store.run_dir, SCHEMA)

    def test_79_valid_policy_blocked_run_is_ineligible_and_validates(self):
        record = self.make_record(status="blocked_policy")
        record["governance"]["quarantineStatus"] = "quarantined_policy_evidence"
        store = self.write_run(record)
        result = validator.validate_run(store.run_dir, SCHEMA)
        self.assertTrue(result["valid"])
        projection = json.loads(
            (store.run_dir / "model_projection.jsonl").read_text(encoding="utf-8")
        )
        self.assertEqual(projection["evidenceStatus"], "blocked_policy")
        self.assertEqual(set(projection["frictionReasonSignals"].values()), {"unknown"})

    def test_80_policy_blocked_observations_cannot_be_general_eligible(self):
        record = self.make_record(status="blocked_policy")
        record["governance"]["quarantineStatus"] = "quarantined_policy_evidence"
        record["page"]["observationsIncluded"] = True
        store = self.write_run(record)
        with self.assertRaisesRegex(
            validator.ValidationError, "cannot enter general evidence"
        ):
            validator.validate_run(store.run_dir, SCHEMA)

    def test_81_clean_collection_round_trips_through_validator(self):
        store, record = self.collect_complete_record()
        paths = [artifact["path"] for artifact in record["artifacts"]]
        viewport_paths = [
            artifact["path"]
            for viewport in record["responsive"].values()
            for artifact in viewport["artifacts"]
        ]
        self.assertEqual(len(paths), len(set(paths)))
        self.assertCountEqual(paths, viewport_paths)
        for viewport in record["responsive"].values():
            self.assertEqual(
                [artifact["kind"] for artifact in viewport["artifacts"]],
                ["raw_text", "screenshot"],
            )
        screenshot_paths = [
            artifact["path"]
            for artifact in record["artifacts"]
            if artifact["kind"] == "screenshot"
        ]
        self.assertTrue(screenshot_paths)
        self.assertTrue(
            all(
                path.startswith("quarantined_visual_evidence/")
                for path in screenshot_paths
            )
        )
        self.write_run(record, store=store)
        result = validator.validate_run(store.run_dir, SCHEMA)
        self.assertTrue(result["valid"])
        projection = json.loads(
            (store.run_dir / "model_projection.jsonl").read_text(encoding="utf-8")
        )
        self.assertEqual(projection["evidenceStatus"], "complete")
        self.assertEqual(set(projection["frictionReasonSignals"].values()), {"unknown"})

    def test_82_validator_rejects_duplicate_artifact_path(self):
        store, record = self.collect_complete_record()
        record["artifacts"].append(copy.deepcopy(record["artifacts"][0]))
        self.write_run(record, store=store)
        with self.assertRaisesRegex(
            validator.ValidationError, "duplicate artifact path"
        ):
            validator.validate_run(store.run_dir, SCHEMA)


class FinalHardeningTests(unittest.TestCase):
    def test_83_sensitive_query_keys_and_values_fail_closed(self):
        policy = collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
        blocked = [
            "https://example.com/?token=secret-value",
            "https://example.com/?API_KEY=value",
            "https://example.com/?next=Bearer%20abcdefghijklmnop",
            "https://example.com/?%2561pi%255fkey=value",
            "https://example.com/?next=%2542earer%2520abcdefghijklmnop",
            "https://example.com/?session=value",
            "https://example.com/?signature=value",
        ]
        for url in blocked:
            with self.subTest(url=url), self.assertRaisesRegex(
                collector.PolicyError, "credential_query_blocked"
            ):
                policy.validate(url)
        self.assertEqual(
            policy.validate("https://example.com/?monkey=banana").hostname,
            "example.com",
        )

    def test_84_cross_authority_redirect_and_subresource_are_blocked(self):
        policy = collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
        guard = collector.EgressGuard(
            policy, allowed_hosts=frozenset({"example.com"})
        )
        route = FakeRoute()
        asyncio.run(
            guard.route(
                route,
                SimpleNamespace(method="GET", url="https://other.com/redirect"),
            )
        )
        self.assertTrue(route.aborted)
        self.assertIn("host_outside_owner_authority", guard.policy_reason_codes)

        subdomain_guard = collector.EgressGuard(
            policy, allowed_hosts=frozenset({"example.com"})
        )
        subdomain_route = FakeRoute()
        asyncio.run(
            subdomain_guard.route(
                subdomain_route,
                SimpleNamespace(
                    method="GET", url="https://assets.example.com/app.js"
                ),
            )
        )
        self.assertTrue(subdomain_route.continued)

    def test_85_final_redirect_host_cannot_complete(self):
        suite = EgressAndSensitiveTests()
        result, _sensitive, guard, _browser = suite.collect_fake_viewport(
            [("GET", "https://example.com/page")],
            final_url="https://other.com/final",
        )
        self.assertEqual(result["status"], "blocked_policy")
        self.assertIn("final_host_outside_owner_authority", guard.policy_reason_codes)

    def test_86_owner_actor_and_temporal_lineage_fail_closed(self):
        bundle = make_bundle()
        bundle["targets"][0]["mappingProvenance"]["mappedBy"] = "other-owner"
        with self.assertRaisesRegex(collector.MappingError, "exactly match"):
            validate_bundle(bundle)

        bundle = make_bundle()
        bundle["targets"][0]["mappingProvenance"]["mappedAt"] = (
            "2026-08-27T23:59:59+00:00"
        )
        with self.assertRaisesRegex(collector.MappingError, "authorization interval"):
            validate_bundle(bundle)

        bundle = make_bundle()
        bundle["authorization"]["approvedAt"] = "2098-01-01T00:00:00+00:00"
        with self.assertRaisesRegex(collector.MappingError, "future"):
            validate_bundle(bundle)

    def test_87_mapping_outputs_non_pii_authority_fingerprints(self):
        target = validate_bundle()[0]
        self.assertRegex(target["ownerAuthorityFingerprint"], r"^[0-9a-f]{64}$")
        self.assertRegex(target["mappingFingerprint"], r"^[0-9a-f]{64}$")
        serialized = collector.canonical_json_bytes(
            {
                "ownerAuthorityFingerprint": target["ownerAuthorityFingerprint"],
                "mappingFingerprint": target["mappingFingerprint"],
            }
        ).decode()
        self.assertNotIn("owner-1", serialized)

    def test_88_replay_rejects_selection_or_owner_drift(self):
        metadata = {
            "runId": "source-run",
            "targetBundleDigest": "a" * 64,
            "parentManifestHash": "b" * 64,
            "parentDatasetDigest": "c" * 64,
            "configDigest": "d" * 64,
            "selectionFingerprint": "e" * 64,
            "ownerAuthorityFingerprint": "f" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
        }
        with self.assertRaisesRegex(collector.MappingError, "selectionFingerprint"):
            collector.validate_replay(
                metadata,
                replay_of="source-run",
                target_bundle_digest="a" * 64,
                parent_manifest_hash="b" * 64,
                parent_dataset_digest="c" * 64,
                config_digest="d" * 64,
                selection_fingerprint="0" * 64,
                owner_authority_fingerprint="f" * 64,
            )

    def test_89_capacity_is_bounded(self):
        self.assertGreater(
            collector.estimated_run_capacity_bytes(2, True),
            collector.estimated_run_capacity_bytes(1, False),
        )
        with self.assertRaises(SystemExit):
            collector.parse_args(
                [
                    "--targets",
                    "/tmp/t",
                    "--parent-dataset",
                    "/tmp/d",
                    "--parent-manifest",
                    "/tmp/m",
                    "--output-dir",
                    "/tmp/o",
                    "--run-id",
                    "run",
                    "--max-run-bytes",
                    str(collector.MAX_RUN_BYTES_HARD_LIMIT + 1),
                ]
            )

    def test_90_in_progress_run_is_never_eligible(self):
        case = ValidatorTests()
        case.setUp()
        try:
            record = case.make_record()
            store = case.write_run(record)
            metadata_path = store.run_dir / "run_metadata.json"
            metadata = json.loads(metadata_path.read_text())
            metadata["state"] = "in_progress"
            metadata_path.write_bytes(collector.canonical_json_bytes(metadata) + b"\n")
            (store.run_dir / "run_complete.json").unlink()
            with self.assertRaisesRegex(validator.ValidationError, "not complete"):
                validator.validate_run(store.run_dir, SCHEMA)
            internal = validator.validate_run(
                store.run_dir, SCHEMA, require_complete=False
            )
            self.assertFalse(internal["eligible"])
        finally:
            case.tearDown()

    def test_91_retention_cleanup_is_dry_run_first_and_receipted(self):
        case = ValidatorTests()
        case.setUp()
        try:
            store = case.write_run(case.make_record())
            now = datetime(2026, 9, 5, tzinfo=timezone.utc)
            dry = cleanup.cleanup_expired_runs(
                case.root, schema_path=SCHEMA, now=now
            )
            self.assertEqual(dry[0]["decision"], "would_delete")
            self.assertTrue(store.run_dir.exists())
            deleted = cleanup.cleanup_expired_runs(
                case.root,
                schema_path=SCHEMA,
                now=now,
                confirm_delete=True,
            )
            self.assertEqual(deleted[0]["decision"], "deleted")
            self.assertFalse(store.run_dir.exists())
            receipt = case.root / cleanup.RECEIPT_NAME
            self.assertTrue(receipt.is_file())
            self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        finally:
            case.tearDown()

    def test_92_non_attested_run_never_resolves_or_starts_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            parent = root / "parent.jsonl"
            parent.write_text('{"rowId":1,"split":"train"}\n', encoding="utf-8")
            manifest = root / "parent-manifest.json"
            manifest.write_text("{}\n", encoding="utf-8")
            bundle = make_bundle()
            bundle["parentLineage"] = {
                "parentManifestHash": collector.sha256_file(manifest),
                "parentDatasetDigest": collector.sha256_file(parent),
                "parentRowCount": 1,
            }
            bundle["authorization"]["approvedAt"] = "2026-08-28T00:00:00+00:00"
            bundle["authorization"]["expiresAt"] = "2099-01-01T00:00:00+00:00"
            targets = root / "targets.page-evidence-targets.private.json"
            targets.write_bytes(collector.canonical_json_bytes(bundle))
            output = root / "output"
            args = SimpleNamespace(
                targets=str(targets),
                parent_dataset=str(parent),
                parent_manifest=str(manifest),
                output_dir=str(output),
                run_id="sandbox-required-run",
                development_only=True,
                network_sandbox_attested=False,
                allow_http=False,
                run_lighthouse=False,
                lighthouse_binary=None,
                chromium_binary=None,
                replay_of=None,
                limit=None,
                host_delay=1.0,
                max_requests=10,
                max_run_bytes=256 * 1024 * 1024,
            )

            async def forbidden_resolver(_host, _port):
                raise AssertionError("resolver must not run without sandbox attestation")

            with patch.dict(
                os.environ, {"DISCOVERYSTACK_PRIVATE_EVIDENCE_DEV": "1"}
            ), patch.object(
                collector, "async_system_resolver", forbidden_resolver
            ):
                asyncio.run(collector.run_collection(args))
            run_dir = output / "sandbox-required-run"
            result = validator.validate_run(run_dir, SCHEMA)
            self.assertTrue(result["eligible"])
            record = json.loads(
                (run_dir / "evidence_manifest.jsonl").read_text(encoding="utf-8")
            )
            self.assertEqual(record["collectionStatus"], "sandbox_required")
            self.assertEqual(record["requestAudit"]["count"], 0)

    def test_93_cleanup_rejects_symlink_without_deleting_target(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "runs"
            root.mkdir(mode=0o700)
            root.chmod(0o700)
            outside = base / "outside"
            outside.mkdir()
            (outside / "keep.txt").write_text("keep", encoding="utf-8")
            (root / "malicious-run").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(
                collector.FilesystemPolicyError, "unexpected output-root entry"
            ):
                cleanup.cleanup_expired_runs(root, schema_path=SCHEMA)
            self.assertEqual((outside / "keep.txt").read_text(), "keep")

    def test_94_completion_marker_hash_tamper_is_rejected(self):
        case = ValidatorTests()
        case.setUp()
        try:
            store = case.write_run(case.make_record())
            marker = store.run_dir / "run_complete.json"
            completion = json.loads(marker.read_text(encoding="utf-8"))
            completion["evidenceManifestHash"] = "0" * 64
            marker.write_bytes(collector.canonical_json_bytes(completion) + b"\n")
            with self.assertRaisesRegex(
                validator.ValidationError, "evidence manifest hash mismatch"
            ):
                validator.validate_run(store.run_dir, SCHEMA)
        finally:
            case.tearDown()

    def test_95_malformed_completion_marker_fails_closed(self):
        case = ValidatorTests()
        case.setUp()
        try:
            store = case.write_run(case.make_record())
            marker = store.run_dir / "run_complete.json"
            marker.write_text("{not-json\n", encoding="utf-8")
            with self.assertRaisesRegex(
                validator.ValidationError, "completion marker is not valid JSON"
            ):
                validator.validate_run(store.run_dir, SCHEMA)
        finally:
            case.tearDown()


if __name__ == "__main__":
    unittest.main()
