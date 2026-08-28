from __future__ import annotations

import asyncio
import copy
import json
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
    return collector.validate_target_bundle(
        bundle or make_bundle(),
        parent_rows=parent_rows or [{"rowId": 1, "split": "train"}],
        actual_parent_manifest_hash="a" * 64,
        actual_parent_dataset_digest="b" * 64,
        policy=collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)),
        now=datetime(2026, 8, 28, tzinfo=timezone.utc),
    )


class FakeRoute:
    def __init__(self):
        self.continued = False
        self.aborted = False

    async def continue_(self):
        self.continued = True

    async def abort(self, _reason):
        self.aborted = True


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

    def test_23_fragment_is_removed_from_canonical_url(self):
        result = self.policy().validate("https://example.com/a?q=1#secret")
        self.assertEqual(result.canonical_url, "https://example.com/a?q=1")

    def test_23b_invalid_hostname_characters_are_rejected(self):
        with self.assertRaisesRegex(collector.PolicyError, "invalid_idna_host"):
            self.policy().validate("https://bad_name.example.org")


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
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
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
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
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
            collector.PublicURLPolicy(resolver=resolver_with("10.0.0.1"))
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
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4)), max_requests=1
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
            collector.PublicURLPolicy(resolver=changing_resolver)
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
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
        )
        guard.on_websocket(object())
        self.assertTrue(guard.websocket_seen)

    def test_66_response_retry_after_is_recorded(self):
        guard = collector.EgressGuard(
            collector.PublicURLPolicy(resolver=resolver_with(PUBLIC_V4))
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
            "collectorVersion": collector.COLLECTOR_VERSION,
        }
        replay = collector.validate_replay(
            metadata,
            replay_of="source-run",
            target_bundle_digest="a" * 64,
            parent_manifest_hash="b" * 64,
            parent_dataset_digest="c" * 64,
            config_digest="d" * 64,
        )
        self.assertTrue(replay["exactReplay"])

    def test_68_exact_replay_rejects_config_drift(self):
        metadata = {
            "runId": "source-run",
            "targetBundleDigest": "a" * 64,
            "parentManifestHash": "b" * 64,
            "parentDatasetDigest": "c" * 64,
            "configDigest": "x" * 64,
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
            )


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def make_record(self, status="sandbox_required"):
        return collector.make_blocked_record(
            run_id="test-run",
            row_id=1,
            split="train",
            lineage={
                "parentManifestHash": "a" * 64,
                "parentDatasetDigest": "b" * 64,
                "parentRowCount": 1,
            },
            mapping={
                "urlHash": "c" * 64,
                "method": collector.ALLOWED_MAPPING_METHOD,
                "evidenceRefHash": "d" * 64,
                "mappedByHash": "e" * 64,
                "mappedAt": "2026-08-28T00:00:00+00:00",
                "authorizationScopeId": "scope-1",
            },
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

    def write_run(self, record, projection=None):
        store = collector.PrivateRunStore(self.root, "test-run")
        metadata = {
            "runId": "test-run",
            "targetBundleDigest": "f" * 64,
            "parentManifestHash": "a" * 64,
            "parentDatasetDigest": "b" * 64,
            "configDigest": "1" * 64,
            "collectorVersion": collector.COLLECTOR_VERSION,
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
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
        return store

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
            "collectorVersion": collector.COLLECTOR_VERSION,
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
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
            validator.validate_run(store.run_dir, SCHEMA)

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
            "collectorVersion": collector.COLLECTOR_VERSION,
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
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
            validator.validate_run(store.run_dir, SCHEMA)

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
            "collectorVersion": collector.COLLECTOR_VERSION,
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
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
            validator.validate_run(store.run_dir, SCHEMA)

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
            "collectorVersion": collector.COLLECTOR_VERSION,
            "createdAt": "2026-08-28T00:00:00+00:00",
            "retentionDays": 7,
            "deleteAfter": "2026-09-04T00:00:00+00:00",
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
            validator.validate_run(store.run_dir, SCHEMA)

    def test_78_schema_requires_complete_mapping_provenance(self):
        record = self.make_record()
        del record["mapping"]["authorizationScopeId"]
        store = self.write_run(record)
        with self.assertRaisesRegex(validator.ValidationError, "missing required"):
            validator.validate_run(store.run_dir, SCHEMA)


if __name__ == "__main__":
    unittest.main()
